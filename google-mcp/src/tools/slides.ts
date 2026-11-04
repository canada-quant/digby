/**
 * Google Slides tools (2026-09-23, owner: "add all of that" — Docs/Sheets/Slides
 * create + edit for Digby agents). Presentations are created from a title and a
 * list of slides; each slide gets a TITLE_AND_BODY layout with its text placed
 * into the placeholders through deterministic object ids (no second read).
 */
import { google } from 'googleapis';

function getAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

export interface SlideSpec { title?: string; body?: string; bullets?: string[] }

const SLIDES_LINK = (id: string) => `https://docs.google.com/presentation/d/${id}/edit`;

/** Batch-update requests that add one TITLE_AND_BODY slide per spec and fill its placeholders. Pure — exported for tests. */
export function buildSlideRequests(slides: SlideSpec[], seed = 'dg'): any[] {
  const requests: any[] = [];
  slides.forEach((s, i) => {
    const id = `${seed}_s${i + 1}`;
    const titleId = `${id}_t`;
    const bodyId = `${id}_b`;
    requests.push({
      createSlide: {
        objectId: id,
        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId },
        ],
      },
    });
    const title = (s.title || '').trim();
    const body = [s.body?.trim() || '', ...(s.bullets || []).map((b) => `• ${String(b).trim()}`)].filter(Boolean).join('\n');
    if (title) requests.push({ insertText: { objectId: titleId, text: title } });
    if (body) requests.push({ insertText: { objectId: bodyId, text: body } });
  });
  return requests;
}

/** Create a presentation and add the given slides. The default first slide Google creates is removed when specs are given. */
export async function slidesCreatePresentation(accessToken: string, title: string, slides: SlideSpec[] = []): Promise<string> {
  const auth = getAuth(accessToken);
  const api = google.slides({ version: 'v1', auth });
  const created = await api.presentations.create({ requestBody: { title } });
  const presentationId = created.data.presentationId!;
  const specs = Array.isArray(slides) ? slides.filter((s) => s && (s.title || s.body || (s.bullets && s.bullets.length))) : [];
  if (specs.length) {
    const requests = buildSlideRequests(specs, `dg${Date.now().toString(36)}`);
    const first = created.data.slides?.[0]?.objectId;
    if (first) requests.push({ deleteObject: { objectId: first } });
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
  }
  return `Created Google Slides "${title}" with ${specs.length} slide(s) — presentationId ${presentationId} — ${SLIDES_LINK(presentationId)}`;
}
