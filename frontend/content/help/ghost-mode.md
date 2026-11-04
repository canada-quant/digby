# Ghost mode

Ghost mode is a per-conversation privacy switch. When it is on, that one
conversation's models are routed to an endpoint the admin of the instance
designated — a self-hosted model — and the conversation is kept out of
Digby's memory, learning and cross-chat surfacing. When it is off, the
conversation behaves exactly like any other.

The honest one-line version, which is also what the switch and the header
badge say:

> Ghost mode routes this chat through the admin's private endpoint and keeps
> it out of memory and learning. Your transcript stays in your account.

## Who can use it

- **Signed-in users** — on your own plain chats. The **ghost** button (the
  little ghost icon) sits beside the composer, next to **+**:
  - On the home screen, press it **before** you send to start the new chat
    in ghost mode — the chat is created private, so even its first message
    runs on the admin's endpoint and stays out of memory and learning. It
    applies to that one new chat; the next new chat starts normal again.
  - In an open chat, press it to turn ghost mode on or off for that chat.
    The same switch is also in the side panel (**Settings** tab).

  The setting is saved on the chat, so every future turn in that chat runs
  in ghost mode until you turn it off. It is not offered on coding sessions
  or supervisor lanes, or on chats other people shared with you.
- **Guests** — in a guest conversation, the ghost toggle sits beside the
  composer. It applies to that conversation only and is remembered in your
  browser (per conversation), so a reopened guest conversation stays in ghost
  mode.

A quiet **Ghost** badge appears next to the conversation's title in the
header whenever the open conversation is in ghost mode. Hover it for the
one-liner.

The conversation still gets its automatic title: it is generated on the
admin-designated endpoint itself (or derived locally from your first message,
with no network call at all, when no endpoint is designated) — never by a
cloud model that the admin did not designate.

Ghost mode is orthogonal to how deeply Digby thinks — it changes where the
models run and what is remembered, not the depth of the answer.

## What the admin designates

The instance's admin chooses ONE self-hosted model that all ghost
conversations run on (**Account → Admin → Endpoints → Model roles → Ghost
mode**). The admin can see, change or clear the designation at any time; a
change applies to new turns.

If no model is designated (or the admin has switched it off), the ghost
toggle still works: the conversation keeps its ghost privacy — it stays out
of memory, learning and cross-chat surfacing — but the answers run on the
instance's normal lineup, and the answer says so. Nothing about a ghost
conversation ever routes through a model the admin did not designate.

## What it does and does not do

**Does:**

- Routes the conversation's models to the admin-designated self-hosted
  endpoint.
- Keeps the conversation out of Digby's per-user memory, out of learning, and
  out of cross-chat surfacing.

**Does not:**

- Delete or hide anything — **your transcript stays in your account** exactly
  where it was, and you can turn ghost mode off at any time.
- Make you anonymous to the instance: the conversation is still yours, in
  your account, under the instance's normal data handling.

If you need a conversation to stay out of memory and learning, flip ghost
mode on before you start it — on the home screen, press the ghost button
beside the composer before your first message. Turning it on in an existing
chat applies from the next turn onward.
