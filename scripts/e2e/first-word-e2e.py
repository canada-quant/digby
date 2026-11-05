#!/usr/bin/env python3
"""
first-word-e2e.py — E2E probe for ticket 4f7263e4 (first-word opener).

One REAL chat turn through the live API (DIGBY_E2E_EMAIL / DIGBY_E2E_PASSWORD —
the canonical prod test account per AGENTS.md; never registers accounts), timed:
  - first_chunk_s      — the first 'chunk' (answer text) event: THE first-word time
  - first_tool_call_s  — the first tool event (the slow web loop STARTING)
  - first_tool_done_s  — the first tool_result (the slow web loop ENDING)
  - opener_before_first_tool_done — did the first word land BEFORE the first web
                         call finished? (the fix's claim: the opener streams at
                         the tool call, not after the whole loop)

Pass criteria (the ticket's bar): first_chunk_s < 60 s AND the first chunk
arrives before the first tool_result completes. A turn where the LEAD's own
reasoning ran long before it wrote anything still shows first_chunk ==
first_tool_call (the opener delivered AT the tool boundary) — the residual
then is lead-side latency, not the dropped-opener seam.

Usage:  python3 scripts/e2e/first-word-e2e.py [--base https://digby.ai] [--question '...']
Env:    DIGBY_E2E_EMAIL / DIGBY_E2E_PASSWORD (required — same vars as
        query-suite.py; fail with a message, never hardcode credentials).
Cleans up its chat unless --keep. Prints a JSON verdict; exit 0 iff ok.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

DEFAULT_BASE = 'https://digby.ai'
DEFAULT_QUESTION = ('Compare the front pages of two major tech news sites right now and tell me '
                    'the one story both lead with, plus one story only one of them carries.')


def login(base, email, password):
    req = urllib.request.Request(
        base + '/api/auth/login',
        data=json.dumps({'email': email, 'password': password}).encode(),
        method='POST', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())['data']['accessToken']


def api(token, method, path, body=None, base=DEFAULT_BASE, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + '/api' + path, data=data, method=method, headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-Digby-View': 'full'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def stream_turn(token, chat_id, message, base, timeout=300):
    import urllib.parse
    params = {'message': message, 'mode': 'auto', 'chatId': chat_id, 'webSearch': 'true'}
    req = urllib.request.Request(
        base + '/api/crossmodel/stream?' + urllib.parse.urlencode(params),
        headers={'Authorization': 'Bearer ' + token, 'X-Digby-View': 'full', 'Accept': 'text/event-stream'})
    events = []
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data: '):
                continue
            try:
                ev = json.loads(line[6:])
            except Exception:
                continue
            events.append({'t': round(time.time() - t0, 2), 'type': ev.get('type'), 'd': ev.get('data') or {}})
            if ev.get('type') in ('complete', 'error'):
                break
    return events


def summarize(events):
    s = {
        'n_events': len(events),
        'first_chunk_s': None, 'first_tool_call_s': None, 'first_tool_done_s': None,
        'first_progress_s': None, 'lane_hint': None, 'complete_s': None,
        'answer_chars': 0, 'first_chunk_is_before_first_tool_call': None,
        'first_chunk_before_first_tool_done': None, 'errors': [],
    }
    for e in events:
        t, d = e['type'], e['d']
        if t == 'chunk' and s['first_chunk_s'] is None:
            s['first_chunk_s'] = e['t']
        if t == 'chunk':
            s['answer_chars'] += len(str(d.get('content') or ''))
        if t == 'agent-activity' and d.get('kind') == 'tool' and s['first_tool_call_s'] is None:
            s['first_tool_call_s'] = e['t']
        if t == 'agent-activity' and d.get('kind') == 'tool_done' and s['first_tool_done_s'] is None:
            s['first_tool_done_s'] = e['t']
        if t == 'progress' and s['first_progress_s'] is None:
            s['first_progress_s'] = e['t']
            msg = str(d.get('message') or '')
            if 'Quick answer' in msg:
                s['lane_hint'] = 'quick'
            elif 'second opinion' in msg.lower() or 'cross-check' in msg.lower():
                s['lane_hint'] = 'checked'
        if t == 'error':
            s['errors'].append(str(d.get('code') or d.get('message') or 'error')[:160])
        if t in ('complete', 'error'):
            s['complete_s'] = e['t']
    if s['first_chunk_s'] is not None and s['first_tool_call_s'] is not None:
        s['first_chunk_is_before_first_tool_call'] = s['first_chunk_s'] < s['first_tool_call_s']
    if s['first_chunk_s'] is not None and s['first_tool_done_s'] is not None:
        s['first_chunk_before_first_tool_done'] = s['first_chunk_s'] < s['first_tool_done_s']
    return s


def dump_timeline(events, n=30):
    """Debug helper: the first N events as (t, type, detail) rows."""
    return [{'t': e['t'], 'type': e['type'],
             'detail': (str((e['d'] or {}).get('message'))[:60] if e['type'] == 'progress'
                        else str((e['d'] or {}).get('content'))[:60] if e['type'] == 'chunk'
                        else (e['d'] or {}).get('kind') or '')}
            for e in events[:n]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--question', default=DEFAULT_QUESTION)
    ap.add_argument('--keep', action='store_true', help='do not delete the probe chat')
    ap.add_argument('--timeline', action='store_true', help='print the first 30 events too')
    args = ap.parse_args()
    email = os.environ.get('DIGBY_E2E_EMAIL')
    password = os.environ.get('DIGBY_E2E_PASSWORD')
    if not email or not password:
        print(json.dumps({'ok': False, 'error': 'DIGBY_E2E_EMAIL / DIGBY_E2E_PASSWORD required '
                                                 '(the canonical prod test account — AGENTS.md)'}))
        return 2

    token = login(args.base, email, password)
    chat = api(token, 'POST', '/crossmodel/chats', {'title': 'e2e first-word probe 4f7263e4'}, base=args.base)
    chat_id = (chat.get('data') or {}).get('id') or ((chat.get('data') or {}).get('chat') or {}).get('id')
    if not chat_id:
        print(json.dumps({'ok': False, 'error': 'no chat id', 'login': 'ok'}))
        return 2
    try:
        events = stream_turn(token, chat_id, args.question, args.base)
        s = summarize(events)
        s['chat_id'] = chat_id
        s['ok'] = bool(
            s['first_chunk_s'] is not None
            and s['first_chunk_s'] < 60.0
            and s['first_chunk_before_first_tool_done'] is not False
            and not s['errors']
        )
        if args.timeline:
            s['timeline'] = dump_timeline(events)
        print(json.dumps(s))
        return 0 if s['ok'] else 1
    finally:
        if not args.keep:
            try:
                api(token, 'DELETE', f'/crossmodel/chats/{chat_id}', base=args.base, timeout=30)
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
