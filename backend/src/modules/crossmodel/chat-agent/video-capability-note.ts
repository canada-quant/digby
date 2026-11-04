/**
 * Video-capability note (ticket e3113ec9, 2026-11-01) — a turn-scoped brief
 * appended to the chat doctrine ONLY on a human turn whose message asks for a
 * VIDEO deliverable.
 *
 * Why a turn-scoped note and not only a doctrine row: the incident ran a
 * 60-second advertising Reel request through several turns — generate_image
 * succeeded 4× on reference frames, external-app prompts were written — and the
 * user's complaint was that the capability gap was never disclosed up front
 * («وقتی بلد نیستی ویدیو بسازی چرا وقتمو می‌گیری — همون اول بگو» — "if you can't
 * build videos, say so at the START"). The playbook's trigger → tool table now
 * carries a VIDEO row (that is the durable doctrine), but one row among ~50 is
 * exactly the kind of advice a run drifts from under multi-turn work. This note
 * makes the disclosure STRUCTURAL on the one turn where it matters: it is
 * composed only when the message really is a video ask, so it costs nothing on
 * every other turn.
 *
 * ── THE CLASSIFIER IS THE HARD PART, AND IT ERRS TOWARD SILENCE ─────────────
 * A false positive is worse than a miss: it injects "Digby cannot generate
 * video" into a turn where Digby genuinely HAS the capability, which is the
 * capability-negation class the repo already treats as a defect (cf.
 * chat-agent/capability-negation). So this file does NOT match "a video noun
 * near a verb". It evaluates the message SENTENCE BY SENTENCE and asks one
 * structural question: *is a video artifact the OBJECT the user asked to be
 * produced?* Five guards, each earned from an adversarial review (2026-11-01)
 * that refuted a first proximity-based draft with 14 realistic inputs:
 *
 *   1. ADVICE / MAINTENANCE sentences are not requests to produce anything.
 *      "how do I make ads on facebook", "what is the best way to make a video",
 *      "recommend a tool to make reels", "make sure the video plays" — all are
 *      questions ABOUT video tooling or playback troubleshooting. Silent.
 *   2. NON-DELIVERABLE COMPOUNDS ("video game", "video call", "video camera",
 *      "video editing app" …) are struck before matching, so "create an image of
 *      a video game character" is an IMAGE ask.
 *   3. The OBJECT of the create verb decides: the FIRST {still|video} noun after
 *      the verb. A still object ("generate an image", "design a poster for a
 *      video", "generate still frames for a reel") is image work — it fires only
 *      when the sentence ALSO names a video OUTPUT seam (", then the video").
 *      A video object ("render a clip from these images") is the ask.
 *   4. UNDERSTANDING an existing video is a capability Digby HAS (youtube_pipe,
 *      scrape_as_markdown): transcribe / summarise / caption / analyse are
 *      vetoed unless a production clause survives stripping them — so
 *      "analyze this clip, then make a Reel" still fires.
 *   5. A KNOWLEDGE deliverable (captions, a transcript, a script, a shot list)
 *      is also a real capability — "create captions for my video" stays silent.
 *
 * Non-English asks are covered by a small distinctive-noun + create-verb layer
 * (the incident's own user wrote in Persian); those words are unambiguous
 * enough that a plain co-occurrence test is safe.
 *
 * "video ad" is deliberately NOT a non-deliverable compound — it is the
 * ticket's own domain ("a 60-second advertising Reel"), and the first draft's
 * compound list killed it while still firing on the bare "make me an ad".
 *
 * Kill switch VIDEO_CAPABILITY_NOTE_DISABLED=1 (the note is not appended; the
 * playbook row still stands).
 *
 * PURE LEAF — no imports at all (same pattern as quick-lane-note.ts /
 * first-word-note.ts), unit-testable without the chat-agent service's import
 * graph.
 */

export const VIDEO_CAPABILITY_NOTE_DISABLED_ENV = 'VIDEO_CAPABILITY_NOTE_DISABLED';

export function videoCapabilityNoteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[VIDEO_CAPABILITY_NOTE_DISABLED_ENV] !== '1';
}

/** Verbs that mean "produce a media artifact FOR me". Deliberately excludes the
 *  everyday words (do / get / have / put / write / give) that appear in most
 *  sentences — "write a video script" is NOT a video-generation ask. */
const CREATE_VERB_SRC = 'make|create|generate|render|animate|produce|shoot|record|film|build|design|draw|assemble|turn|convert|edit|cut|put together';

/** A VIDEO-shaped deliverable. Bare "short" / "storyboard" / "screen recording"
 *  are excluded on purpose: "in short", "a short answer" and a storyboard-only
 *  ask are things Digby can already answer (the note itself OFFERS a
 *  storyboard), so firing there would disclose a false gap. */
const VIDEO_NOUN_SRC = 'video|videos|reel|reels|clips?|animations?|motion graphics?|montage|b-?roll|commercials?|adverts?|advertisements?|ads?|tiktok|youtube shorts?|ig reels?|instagram reels?|facebook reels?';

/**
 * Request verbs that ASK for an artifact without naming a production verb —
 * "I need a video ad for Facebook", "we want a reel". Kept separate from
 * CREATE_VERB_SRC because these are also advice idioms ("I want to learn how to
 * make videos"), which the advice guard has to catch first.
 */
const REQUEST_VERB_SRC = 'need|needs|want|wants|would like|looking for|after|require';

/** A STILL deliverable — image work, a capability Digby really has. */
const STILL_NOUN_SRC = 'images?|pictures?|photos?|stills?|frames?|keyframes?|thumbnails?|storyboards?|mock-?ups?|logos?|illustrations?|drawings?|posters?|banners?|artwork|covers?|graphics?|portraits?|avatars?';

const OBJECT_WINDOW = 32;

/**
 * Guard 1 — advice / meta questions and playback maintenance. A sentence that
 * asks HOW or WHICH TOOL, or asks for advice, or says "make sure …", is not a
 * request to produce a video: the lead must never open such a turn with a
 * capability disclaimer.
 */
const ADVICE_OR_MAINTENANCE_RE = /\bhow (?:do|does|did|can|could|would|should|much|many|long|to)\b|\bwhat (?:is|are|was|should|would|tool|tools|software|app|apps|editor|editors|platform|program)\b|\b(?:which|what) (?:tool|software|app|editor|platform|service|program)s?\b|\b(?:recommend|suggest|advice|advise|best way|any (?:good )?(?:tool|app|software|platform)|tutorial|learn how|teach me)\b|\bmake sure\b/i;

/**
 * Guard 2 — video words that MODIFY something else and are never a deliverable.
 * Struck before matching, so the noun around them can no longer pair with a
 * create verb. NOTE: "video ad(s)" / "video commercial(s)" are NOT here — they
 * ARE the deliverable (the ticket's own advertising-Reel class).
 */
const NON_DELIVERABLE_COMPOUND_RE = /\bvideo\s+(?:game|games|call|calls|camera|cameras|player|players|editors?|editing|cards?|conference|conferencing|chats?|streams?|surveillance|doorbell|settings?|quality|resolution|codecs?|formats?|meetings?|sites?|converter|compressor|hosting|platforms?|rendering|compression|conversion|software|app|apps|api|apis|tutorial|courses?|studio|studios?|player|playback)\b|\bad\s+hoc\b|\bad\s+lib\b/gi;

/** Guard 4 — understanding an EXISTING video: a capability Digby really has. */
const UNDERSTAND_RE = /\b(transcri\w*|summari[sz]\w*|summary|subtitles?|captions?|captioning|what (?:is|was) said|what does (?:this|the) (?:video|clip|reel) (?:say|show)|explain (?:this|the) (?:video|clip|reel)|analy[sz]\w*|analys\w*|extract\w*|review\w*|downloa?d\w*)\b/i;

/** Guard 5 — a KNOWLEDGE deliverable is the object: captions, a transcript, a
 *  script, a shot list. All of those Digby really can produce. */
const KNOWLEDGE_OBJECT_RE = new RegExp(
  `\\b(?:${CREATE_VERB_SRC}|write|draft|prepare|give me|outline|need)\\b[^.!?\\n]{0,20}\\b(?:captions?|subtitles?|transcripts?|translations?|summar(?:y|ies)|analys[ie]s|reports?|scripts?|screenplays?|shot ?lists?|storyboards?|briefs?|outlines?|plans?|ideas?|concepts?)\\b`,
  'i',
);

/**
 * Guard 3's escape — the message still names a video OUTPUT seam: "…, then the
 * video", "… into a video", "followed by the video", or an explicit container
 * format. "generate still frames for a reel" deliberately does NOT match ("for
 * a" is not a seam — the stills ARE the deliverable), while the incident's own
 * "a scenario plus reference frames, then the video" does.
 */
const VIDEO_OUTPUT_SEAM_RE = /\b(?:then|into|and|plus|followed by|before|ending with|finishing with)\b[^.!?\n]{0,26}\b(?:video|videos|reel|reels|clips?|animations?|mp4|webm|mov)\b|\b(?:mp4|webm|mov|mkv)\b/i;

/** An explicit video FORMAT / LENGTH ask stands alone ("a 60-second ad"). */
const FORMAT_RE = new RegExp(
  `\\b(?:mp4|webm|mov|mkv)\\b` +
  `|\\b(?:${VIDEO_NOUN_SRC})\\b[^.!?\\n]{0,16}\\b\\d{1,3}[- ]?(?:s|sec|secs|second|seconds|min|mins|minute|minutes)\\b` +
  `|\\b\\d{1,3}[- ]?(?:s|sec|secs|second|seconds|minute|minutes|min)\\b[^.!?\\n]{0,16}\\b(?:${VIDEO_NOUN_SRC})\\b`,
  'i',
);

/**
 * The IMAGE-TO-VIDEO shape (the ticket's own ask): you ANIMATE a still and get
 * motion back. A plain "edit this photo" must NOT fire — "edit" alone is not
 * motion — so the still must be carried by an explicit animate/into-motion verb.
 */
const ANIMATE_STILL_RE = new RegExp(
  `\\b(?:animate|animating|animated)\\b[^.!?\\n]{0,${OBJECT_WINDOW}}\\b(?:${STILL_NOUN_SRC})\\b` +
  `|\\b(?:bring|make|put)\\b[^.!?\\n]{0,${OBJECT_WINDOW}}\\b(?:${STILL_NOUN_SRC})\\b[^.!?\\n]{0,${OBJECT_WINDOW}}\\b(?:to life|move|moving|move around|in motion|motion|animated|animation|into a video|into motion)\\b` +
  `|\\b(?:turn|convert|render)\\b[^.!?\\n]{0,${OBJECT_WINDOW}}\\b(?:${STILL_NOUN_SRC})\\b`,
  'i',
);

/**
 * Non-English layer (the incident's own user wrote in Persian). These video
 * nouns are distinctive enough that a plain co-occurrence with a create verb is
 * safe; the create-verb list is the common request form in each language.
 */
const INTL_VIDEO_NOUN_RE = /ویدیو|ویدئو|كلیپ|کلیپ|ریلز|فیلم|فيديو|مقطع|视频|影片|動画|ビデオ|동영상|비디오|видео|ролик|vídeo|vidéo|वीडियो|వీడియో|வீடியோ/i;
/**
 * Non-Latin request verbs — matched WITHOUT word boundaries (CJK / Arabic /
 * Cyrillic scripts have none in the JS sense).
 */
const INTL_CREATE_VERB_NONLATIN_RE = /بساز|درست کن|بسازید|اصنع|اعمل|制作|做|生成|作成|만들|생성|сдела|созда|сними|वीडियो|बनाओ|बनाएं/i;
/**
 * LATIN-script request verbs — word-boundaried on purpose: an unbounded "crea"
 * matches inside the English "create", which would let the intl path fire on
 * English image asks ("create an image of a video game").
 */
const INTL_CREATE_VERB_LATIN_RE = /\b(?:haz|hacer|hazme|crea|crear|fais|faire|créer|crée|erstelle|erstellen|mach|machen|generier\w*|faça|fazer|criar|gerar|fammi|creare)\b/i;

/** The intl path needs a Latin verb OR a non-Latin one, plus (below) a video noun
 *  — and a Latin verb only counts when the message also carries non-ASCII text,
 *  so an all-English message can never reach this layer by accident. */
function intlAsk(raw: string): boolean {
  if (INTL_UNDERSTAND_RE.test(raw)) return false;
  if (INTL_VIDEO_NOUN_RE.test(raw)) return INTL_CREATE_VERB_NONLATIN_RE.test(raw) || INTL_CREATE_VERB_LATIN_RE.test(raw);
  // Plain "video"/"film"/"clip" in a NON-English message ("haz un video de 60
  // segundos", "erstelle ein Video"): the Latin verb must be word-boundaried AND
  // the text must carry a non-ASCII character, which keeps English out.
  const nonAscii = /[^\x00-\x7F]/.test(raw);
  if (!nonAscii) return false;
  if (!/\b(?:video|vídeo|vidéo|film|clips?|reels?|animaci[oó]n)\b/i.test(raw)) return false;
  return INTL_CREATE_VERB_LATIN_RE.test(raw) || INTL_CREATE_VERB_NONLATIN_RE.test(raw);
}

/** Guards for the intl layer: understanding/advice phrases that must not fire. */
const INTL_UNDERSTAND_RE = /خلاصه|ترجمه|زیرنویس|تلخیص|ترجمة|ملخص|摘要|字幕|要約|자막|요약|субтитр|пересказ|resum|subti|sous-titre|untertitel|legenda|riassum/i;

export interface VideoAskSignals {
  /** A production verb's first object noun is a video-shaped deliverable. */
  videoObject: boolean;
  /** The first object noun is a still — image work. */
  stillObject: boolean;
  /** An explicit video format / length ask. */
  format: boolean;
  /** The image-to-video shape: "animate this picture". */
  animateStill: boolean;
  /** The sentence is about understanding an existing video. */
  understand: boolean;
  /** The object is a knowledge deliverable Digby CAN make. */
  knowledgeObject: boolean;
  /** The sentence names a video output seam (", then the video"). */
  videoOutputSeam: boolean;
  /** The sentence is advice / a meta question / playback maintenance. */
  advice: boolean;
  /** A non-English video ask (distinctive noun + create verb). */
  intl: boolean;
  /** The first matched token, for tests + telemetry. */
  match?: string;
}

const norm = (s: string) => s.replace(NON_DELIVERABLE_COMPOUND_RE, ' · ');

/**
 * Guard 3's core: after the EARLIEST create verb in the sentence, which noun
 * comes first — a still or a video deliverable? Returns null when neither is
 * within the window (the sentence asks for no media artifact).
 */
export function objectNounType(sentence: string): 'still' | 'video' | null {
  const text = norm(sentence);
  const verb = new RegExp(`\\b(?:${CREATE_VERB_SRC}|${REQUEST_VERB_SRC})\\b`, 'i').exec(text);
  if (!verb) return null;
  const from = verb.index + verb[0].length;
  const tail = text.slice(from, from + OBJECT_WINDOW);
  const still = new RegExp(`\\b(?:${STILL_NOUN_SRC})\\b`, 'i').exec(tail);
  const video = new RegExp(`\\b(?:${VIDEO_NOUN_SRC})\\b`, 'i').exec(tail);
  if (!still && !video) return null;
  if (still && !video) return 'still';
  if (video && !still) return 'video';
  return still!.index <= video!.index ? 'still' : 'video';
}

/** Sentence-level signal read — exported so a test pins the CLASSIFIER. */
export function sentenceSignals(sentence: string): VideoAskSignals {
  const text = norm(sentence);
  const obj = objectNounType(sentence);
  const video = new RegExp(`\\b(?:${VIDEO_NOUN_SRC})\\b`, 'i').exec(text);
  const animateStill = ANIMATE_STILL_RE.test(text);
  const format = FORMAT_RE.test(text);
  return {
    videoObject: obj === 'video',
    stillObject: obj === 'still',
    format,
    animateStill,
    understand: UNDERSTAND_RE.test(text),
    knowledgeObject: KNOWLEDGE_OBJECT_RE.test(text),
    videoOutputSeam: VIDEO_OUTPUT_SEAM_RE.test(text),
    advice: ADVICE_OR_MAINTENANCE_RE.test(text),
    intl: false,
    match: video?.[0] ?? (animateStill ? 'animate-still' : format ? 'format' : undefined),
  };
}

/** Whole-message signal read (the union over its sentences + the intl layer). */
export function videoAskSignals(message: string): VideoAskSignals {
  const raw = String(message ?? '');
  const sentences = raw.split(/[.!?\n;]+/).map(s => s.trim()).filter(Boolean);
  const per = (sentences.length ? sentences : [raw]).map(sentenceSignals);
  const pick = <K extends keyof VideoAskSignals>(k: K) => per.some(s => !!s[k]);
  const intl = intlAsk(raw);
  return {
    videoObject: pick('videoObject'),
    stillObject: pick('stillObject'),
    format: pick('format'),
    animateStill: pick('animateStill'),
    understand: pick('understand'),
    knowledgeObject: pick('knowledgeObject'),
    videoOutputSeam: pick('videoOutputSeam'),
    advice: per.every(s => s.advice),
    intl,
    match: per.find(s => s.match)?.match ?? (intl ? 'intl' : undefined),
  };
}

/** True when this ONE sentence asks for a video artifact to be produced. */
function sentenceAsksForVideo(sentence: string): boolean {
  const s = sentenceSignals(sentence);
  if (s.advice) return false;                                   // guard 1
  const hasShape = s.videoObject || s.format || s.animateStill;
  if (!hasShape) return false;
  // guard 4: understanding an existing video — unless a production clause survives it.
  if (s.understand) {
    const stripped = norm(sentence).replace(new RegExp(UNDERSTAND_RE.source, 'gi'), ' · ');
    const rebuilt = sentenceSignals(stripped);
    if (!rebuilt.videoObject && !rebuilt.format && !rebuilt.animateStill) return false;
  }
  // guard 5: a knowledge deliverable is the object.
  if (s.knowledgeObject && !s.animateStill && !s.format) return false;
  // guard 3: a still is the object — image work — unless a video output seam or
  // explicit format says a video is still the deliverable.
  if (s.stillObject && !s.videoObject && !s.animateStill && !s.format && !s.videoOutputSeam) return false;
  return true;
}

/**
 * True when the turn is a request to PRODUCE a video artifact. Every guard in
 * the header is applied per sentence; the message fires when ANY sentence asks.
 */
export function isVideoGenerationAsk(message: string): boolean {
  const raw = String(message ?? '');
  if (!raw.trim()) return false;
  const sentences = raw.split(/[.!?\n;]+/).map(s => s.trim()).filter(Boolean);
  if (sentences.some(sentenceAsksForVideo)) return true;
  // Non-English layer: a video noun plus a request verb, never an understanding
  // ask (in any of the covered languages) — see intlAsk.
  return intlAsk(raw);
}

/**
 * The brief (empty string when it does not apply — kill switch, a non-ask, or
 * a message with nothing to say). The caller appends it to a HUMAN plain-chat
 * turn only: a machine wake has no user waiting and no first line to protect.
 */
export function videoCapabilityNote(message: string, env: Record<string, string | undefined> = process.env): string {
  if (!videoCapabilityNoteEnabled(env)) return '';
  if (!isVideoGenerationAsk(message)) return '';
  return [
    '## This turn asks for a VIDEO (read this before your first tool call)',
    'Digby has NO video generation: no text-to-video, no image-to-video, no animation renderer. Do not search for one, do not spend turns on reference frames or planning first, and never imply a video is coming. Say it in your FIRST line, in one sentence, in the same language the user wrote in.',
    'Then DO what you can in the SAME answer, and name what the user needs on their side:',
    '- `generate_image` for still frames (a hero frame, per-shot key art) — it works right now and the images land in this chat.',
    '- A shot list / storyboard table: shot number, duration, camera, subject, action, and the exact on-screen text.',
    '- A ready-to-paste prompt for the video tool the user actually has — name a vendor only when they named one first; otherwise ask which tool, in that same answer, instead of guessing.',
    '- A script / voiceover narration with timings, so the Reel is ready to shoot or drop into an editor.',
    'Never end by implying the video is in progress, queued, or will arrive later.',
  ].join('\n');
}