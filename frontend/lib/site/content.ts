/**
 * Public marketing / SEO site content for digby.example.com (owner 2026-10-14: "build
 * out a full SEO plan and execute … so we can start getting organic users
 * searching for private canada ai, sovereign canada ai models, canada ai
 * chatbot … make sure everything is always interlinking and there is a way to
 * always get back to the root domain to chat").
 *
 * ONE data module drives every public page (app/(site)/[slug], /learn/[slug]),
 * the header, menu + footer navigation, the sitemap and the JSON-LD — so a new
 * page is one entry here and it is linked, mapped and structured everywhere.
 * Plan + keyword map: docs/SEO_PLAN_2026-10-14.md. Layout / component spec:
 * the 2026-10-16 site redesign (mobile-first, desktop-optimised).
 *
 * CLAIMS DISCIPLINE (keep it this way — a page that over-promises is worse for
 * trust and for search than one that says less):
 *  - "stored in Canada" = the app database + file storage live in the AWS
 *    Canada Central region (Montréal) — true of the production topology.
 *  - "models run in Canada on Canadian hardware" — OWNER-STATED 2026-10-14
 *    ("yes claim the models run in canada on canadian hardware"): the chat
 *    seats are served through the Canadian model gateway; the owner confirmed
 *    2026-10-16 that EVERY seat (embeddings, rerank, vision, utility,
 *    decision too) runs in Canada. Keep it true: a seat moved to a provider
 *    outside Canada makes these pages wrong.
 *  - "custom-tuned open models" — OWNER-REQUESTED wording 2026-10-16 (site
 *    redesign brief); the /open-source-ai "tunes them for accuracy, safety and
 *    the way Canadians work" claim was CONFIRMED by the owner 2026-10-16.
 *  - No model VENDOR names (Kimi, GLM, DeepSeek, Qwen …) in visible copy,
 *    titles or descriptions (owner 2026-10-16). `keywords` keep them ON
 *    PURPOSE (owner 2026-10-16: "we want seo boost"); content.test.ts pins it.
 *  - "Does my data leave Canada?" is answered precisely (2026-10-16 review):
 *    storage + the answering models are in Canada, but a web search sends the
 *    search query to a search service, a connected app (Gmail, Slack …) talks
 *    to that app, and the site's analytics / ad tags go to Google and Meta
 *    (privacy §7). Never answer it with a bare "No".
 *  - TRAINING: Digby never uses user content (chats, memory, files) to train
 *    or fine-tune AI models — OWNER-CONFIRMED 2026-10-16 and stated in privacy
 *    §3–§4 the same day; content.test.ts pins the policy sentence. Keep the
 *    site and the policy saying the same thing.
 *  - Competitor facts (the /digby-vs-* pages) are dated and sourced from the
 *    vendors' own pages (researched 2026-10-16); re-check them when a page's
 *    `updated` date is refreshed.
 *  - No "compliant / certified" language — Digby has no PIPEDA / Law 25 /
 *    SOC 2 certification to cite. "Not legal advice" on the guides.
 */

import { cityPages } from './cities';
import { PRICING_FAQ_QUESTION, PRICING_FAQ_QUESTION_FR, PRICING_ROW_VALUE, pricingAnswer, pricingAnswerFr } from './pricing';

export const SITE_URL = 'https://digby.example.com';
export const SITE_NAME = 'Digby';
export const CONTACT_EMAIL = 'digby@digby.example.com';
/** Where every "Start chatting" CTA goes — the chat lives at the root domain. */
export const CHAT_HREF = '/';

export interface ContentLink { href: string; label: string }

export interface ContentSection {
  heading: string;
  paragraphs?: string[];
  /** Rendered as numbered rows; a short lead phrase ("Lead — rest", "Lead: rest") becomes a bold line. */
  bullets?: string[];
  /** Optional links rendered as full-width rows under the section. */
  links?: ContentLink[];
  /** 'inverse' = the page's one dark (bg-send) block. */
  tone?: 'inverse';
  /** Short labels rendered as pills (integrations, use cases …). */
  chips?: string[];
  /** A one-line shell command shown in a mono block ("$ " is added). */
  code?: string;
  /** A comparison table (the /digby-vs-* pages): first column = the row label. */
  table?: ComparisonTableData;
  /** Source links shown under the section in small type (competitor facts). */
  sources?: ContentLink[];
}

export interface ComparisonTableData {
  /** Column headings after the row-label column, e.g. ['Digby', 'ChatGPT']. */
  columns: string[];
  rows: { label: string; cells: string[] }[];
  /** One-line footnote under the table ("As of October 2026 …"). */
  note?: string;
}

/** Product screenshots (public/site/shots) — see lib/site/shots.ts. */
export type ShotKey = 'answer' | 'sources' | 'memory' | 'integrations' | 'coding';

export interface Faq { q: string; a: string }

export type LearnTopic = 'Sovereignty' | 'Privacy' | 'Models' | 'Work';
export const LEARN_TOPICS: LearnTopic[] = ['Sovereignty', 'Privacy', 'Models', 'Work'];

export interface SitePage {
  slug: string;
  /** <title> (absolute). */
  title: string;
  description: string;
  /** Short name for nav / breadcrumbs / cards. */
  nav: string;
  eyebrow: string;
  h1: string;
  lede: string;
  keywords: string[];
  sections: ContentSection[];
  faqs?: Faq[];
  /** Hide the "Frequently asked questions" heading (the FAQ page's h1 already says it). */
  faqHeading?: false;
  /** Slugs (landing pages or learn articles, prefixed `learn/`) shown as related reading. */
  related: string[];
  /** BCP-47 language of the page body (default 'en-CA'). */
  lang?: string;
  /** Footer / nav grouping. 'local' = the city × vertical layer (cities.ts). */
  group: 'product' | 'canada' | 'compare' | 'company' | 'local';
  /** Last meaningful content change (YYYY-MM-DD) — the sitemap's lastmod. */
  updated: string;
  /** A product screenshot under the hero. */
  shot?: ShotKey;
  /** The same page in another language (hreflang): e.g. { lang: 'fr-CA', slug: 'ia-souveraine-canada' }. */
  alternate?: { lang: string; slug: string };
  /** Hero primary button follows the visitor's platform (the download page). */
  platformCta?: boolean;
  /** Primary hero CTA label (default "Start chatting free"). */
  cta?: string;
  /** Secondary hero button — never the page itself (default See features → /features). */
  secondary?: ContentLink;
  /** Sticky ask-bar placeholder (default "Ask Digby anything…"). */
  askPlaceholder?: string;
  /** Two suggested prompts that open the chat prefilled (/?q=…). */
  prompts?: string[];
  /** Short blurb for "Keep reading" cards (falls back to `description`). */
  card?: string;
}

export interface LearnArticle {
  slug: string;
  title: string;
  description: string;
  nav: string;
  h1: string;
  lede: string;
  keywords: string[];
  published: string;
  updated: string;
  readMinutes: number;
  topic: LearnTopic;
  sections: ContentSection[];
  faqs?: Faq[];
  related: string[];
  askPlaceholder?: string;
  prompts?: string[];
  card?: string;
  shot?: ShotKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Landing pages (order sets footer order within each group)
// ─────────────────────────────────────────────────────────────────────────────

const CORE_SITE_PAGES: SitePage[] = [
  {
    slug: 'about',
    group: 'company',
    updated: '2026-10-16',
    nav: 'About',
    title: 'About Digby — the Canadian AI assistant',
    description: 'Digby is a Canadian-built AI assistant on custom-tuned open models running on Canadian hardware, with your chats, memory and files stored in Canada.',
    eyebrow: 'About Digby',
    h1: 'A Canadian AI assistant you can actually trust',
    lede: 'Built in Canada for people and teams who want frontier-quality help without handing their work to a black box.',
    keywords: ['about digby', 'canadian ai company', 'canadian ai assistant', 'digby ai'],
    secondary: { href: '/features', label: 'See features' },
    shot: 'answer',
    card: 'A Canadian-built assistant: checked, sourced and yours to control.',
    prompts: ['What makes you different from ChatGPT?', 'Who built Digby?'],
    sections: [
      {
        heading: 'Why we built Digby',
        paragraphs: [
          'Most assistants ask you to trade control for convenience: your chats live wherever the vendor decides, the model is a secret, and one confident reply is all you get.',
          'Digby keeps your data in Canada, runs on open-weight models, and treats accuracy as a process. Hard questions get a second model checking the first; research questions get a team of models working in parallel.',
          'We think Canadians — and Canadian organisations — should be able to use the best AI available without giving up where their information lives or who controls the tools they depend on.',
        ],
        links: [{ href: '/sovereign-ai', label: 'What sovereign AI means for Canada' }, { href: '/private-ai', label: 'Private AI for Canadians' }],
      
      },
      {
        heading: 'What we believe',
        bullets: [
          'Your data should live where you live. Accounts, chats, memory and files are stored in Canada, and the models run on Canadian hardware.',
          'Open beats opaque. No single company should own the intelligence your work depends on.',
          'One answer isn’t enough when it matters. Important answers are cross-checked by an independent model.',
          'You stay in control. See, edit and delete what Digby remembers, and any conversation, any time.',
          'AI should be good for kids too. Digby Kids helps children think — it never does the thinking for them.',
        ],
        links: [{ href: '/open-source-ai', label: 'Why Digby runs open-weight models' }, { href: '/faq', label: 'Short answers to the common questions' }],
      
      },
      {
        heading: 'How Digby works',
        paragraphs: [
          'Every message starts with a plan. Digby decides whether a question is a quick lookup, an everyday task, something contested or high-stakes, or a research project — and gives it the matching amount of work.',
          'It picks a model suited to the task, searches the live web when facts are current or disputed, and cites what it found. On the answers that matter most, a different model reviews the first one before you rely on it. And when you want more, “Dig deeper” under any answer starts an independent check or a full research pass.',
        ],
        links: [{ href: '/learn/how-digby-double-checks-answers', label: 'How Digby double-checks answers' }],
      },
      {
        heading: 'Who Digby is for',
        tone: 'inverse',
        bullets: [
          'Everyday Canadians — writing, research, planning and learning.',
          'Professionals and small businesses — answers you can stand behind.',
          'Developers — a coding agent that opens real pull requests.',
          'Families — a safe AI tutor for kids.',
        ],
        links: [{ href: '/features', label: 'See everything Digby can do' }],
      },
      {
        heading: 'Talk to us',
        paragraphs: ['Questions, partnerships or press — email us and a person will reply. Or just start a chat: you don’t need an account.'],
        links: [{ href: `mailto:${CONTACT_EMAIL}`, label: `Email ${CONTACT_EMAIL}` }],
      },
    ],
    faqs: [
      { q: 'Is Digby Canadian?', a: 'Yes. Digby is built in Canada, stores its users’ accounts, conversations, memory and files in Canada, and runs its answering models on Canadian hardware.' },
      { q: 'How do I contact Digby?', a: `Email ${CONTACT_EMAIL}. For product questions you can also just ask Digby in a chat.` },
    ],
    related: ['features', 'sovereign-ai', 'private-ai', 'learn/where-your-data-goes'],
  },
  {
    slug: 'features',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Features',
    title: 'Digby features — research, writing, files and code',
    description: 'Live web search with sources, double-checked answers, deep research, PDFs and files, memory, projects, an AI coding agent, integrations and desktop apps.',
    eyebrow: 'Features',
    h1: 'One assistant for research, writing, files and code',
    lede: 'Digby picks the right open-weight model for each question, searches the live web when facts matter, and double-checks itself when being wrong is expensive.',
    keywords: ['ai assistant features', 'ai chatbot with web search', 'ai pdf analysis', 'ai research assistant canada'],
    secondary: { href: '/deep-research', label: 'Try deep research' },
    shot: 'answer',
    askPlaceholder: 'Ask what Digby can do…',
    card: 'Live web search, double-checked answers, deep research, files, memory, projects, coding and integrations.',
    prompts: ['Summarise a 40-page PDF into five bullets', 'Find the best e-bike under $2,000 and cite sources'],
    sections: [
      {
        heading: 'Answers that are researched and checked',
        bullets: [
          'Live web search — when a question is time-sensitive, disputed or beyond what a model knows, Digby searches and cites what it found.',
          'Automatic depth — quick questions get fast answers. High-stakes ones get a second model checking the first.',
          '“Dig deeper” — one tap under any answer escalates to an independent check or a full research pass.',
          'Deep research — a council of models researches in parallel; Digby writes one sourced report.',
          'How Digby answered — every answer shows its sources and the work behind it.',
        ],
        links: [{ href: '/deep-research', label: 'How deep research works' }],
      },
      {
        heading: 'Bring your own files and knowledge',
        bullets: [
          'Files — PDFs, Word documents, spreadsheets, images and code, read natively.',
          'Projects — related chats, shared instructions and a searchable knowledge base in one place.',
          'Memory — facts and preferences you share, reviewable and deletable any time.',
          'Knowledge base — add documents and web pages once; Digby answers from the relevant passages.',
        ],
        links: [{ href: '/industries', label: 'Setups shaped around your sector' }, { href: '/ai-for-business', label: 'Digby for Canadian teams' }],
      
      },
      {
        heading: 'Make things, not just answers',
        paragraphs: [
          'Ask for a document, a spreadsheet, a slide outline or an image and Digby hands it back as a file you can download. Longer pieces open in a side panel where you can read, copy and keep refining them.',
          'Writing help works the way you do: draft from bullet points, rewrite for a different reader, translate between English and French, or tighten a page to half its length.',
        ],
        links: [{ href: '/download', label: 'Get the Digby apps' }, { href: '/chatgpt-alternative', label: 'Coming from ChatGPT?' }, { href: '/canadian-ai-chatbot', label: 'The Canadian AI chatbot' }],
      
      },
      {
        heading: 'Work across your tools',
        chips: ['Gmail', 'Calendar', 'Drive', 'Slack', 'GitHub', 'Asana', 'Xero', 'Discord', 'Telegram', 'iMessage', 'MCP'],
        paragraphs: ['Connect the apps you use, message Digby from Telegram or iMessage, and schedule briefings and recurring research that run while you’re away.'],
        links: [{ href: '/integrations', label: 'All integrations' }],
      },
      {
        heading: 'Build software with Digby Code',
        tone: 'inverse',
        paragraphs: ['An AI coding agent in a real workspace: it reads your repository, writes and runs code, verifies its changes and opens pull requests on GitHub. Hand off a task from any chat and the result comes back to that chat.'],
        links: [{ href: '/ai-coding-agent', label: 'Meet Digby Code' }],
      },
      {
        heading: 'Everywhere you are',
        bullets: [
          'Web — digby.example.com, installable on iPhone, iPad and Android.',
          'Desktop — native apps for macOS and Windows.',
          'Voice — talk to Digby and have answers read aloud.',
          'Kids — a separate, safe Socratic tutor for children.',
        ],
        links: [
          { href: '/download', label: 'Get the apps' },
          { href: '/digby-kids', label: 'Digby Kids' },
        ],
      },
    ],
    faqs: [
      { q: PRICING_FAQ_QUESTION, a: pricingAnswer() },
      { q: 'Which AI models does Digby use?', a: 'Custom-tuned open models, chosen per question. On harder questions a second model independently checks the answer.' },
      { q: 'Can Digby read my PDFs and spreadsheets?', a: 'Yes. Attach a file to a message, or add documents to a project’s knowledge base so every chat in the project can use them.' },
      { q: 'Does Digby search the web?', a: 'Yes, when a question needs current or disputed facts. Answers list the sources Digby used so you can check them.' },
    ],
    related: ['deep-research', 'ai-coding-agent', 'integrations', 'open-source-ai'],
  },
  {
    slug: 'private-ai',
    group: 'canada',
    updated: '2026-10-16',
    nav: 'Private AI',
    title: 'Private AI chat for Canadians — models and data in Canada',
    description: 'Digby is private AI for Canadians: models run on Canadian hardware, your chats, memory and files are stored in Canada, and you can delete everything.',
    eyebrow: 'Private AI · Canada',
    h1: 'Private AI for Canadians',
    lede: 'Digby’s models run on Canadian hardware, and your account, chats, memory and files are stored in Canada. You can see — and delete — everything it remembers.',
    keywords: ['private ai canada', 'private ai chatbot', 'private ai assistant', 'canadian private ai', 'secure ai chat canada'],
    cta: 'Start chatting privately',
    secondary: { href: '/sovereign-ai', label: 'Sovereign AI' },
    shot: 'memory',
    askPlaceholder: 'Ask about your privacy…',
    card: 'Models on Canadian hardware. Chats, memory and files stored in Canada. You can delete everything.',
    prompts: ['What do you remember about me?', 'Where exactly is this chat stored?'],
    sections: [
      {
        heading: 'Your data and the AI stay in Canada',
        paragraphs: [
          'Your account, chat history, uploads and memory are stored in Montréal (the Canada Central region) — not in a data centre in another country. The models that write Digby’s answers run on hardware located in Canada.',
          'Two things necessarily reach the outside world, and we’d rather say so plainly: when Digby searches the web, the search query goes to a search service and pages are fetched from the public web; and when you connect an app such as Gmail or Slack, Digby talks to that app on your behalf.',
        ],
        links: [{ href: '/learn/where-your-data-goes', label: 'Where your data goes, step by step' }],
      },
      {
        heading: 'You decide what Digby remembers',
        bullets: [
          'Memory is visible: open Settings and read every fact Digby has saved about you.',
          'Memory is editable: correct or delete any fact, or clear it all.',
          'Conversations are yours: delete one chat or your whole history at any time.',
          'Sharing is opt-in: nothing is visible to anyone unless you create a share link — and you can revoke it.',
        ],
        links: [{ href: '/compliance', label: 'What Digby does and does not claim' }, { href: '/canadian-ai-chatbot', label: 'What people ask Digby every day' }, { href: '/learn/choosing-a-private-ai-chatbot', label: 'Choose a private chatbot that holds up' }],
      
      },
      {
        heading: 'Private by design, not by promise',
        tone: 'inverse',
        paragraphs: ['Models see the conversation they need to answer — never your password or account credentials — and your chats, memory and files are never used to train AI models. Answers come from open-weight models rather than one closed foreign vendor, and organisations can run every step on their own infrastructure.'],
        links: [
          { href: '/self-hosted-ai', label: 'Run Digby on your own servers' },
          { href: '/privacy', label: 'Read the privacy policy' },
        ],
      },
      {
        heading: 'Privacy for teams',
        paragraphs: [
          'Shared projects use roles — viewer, editor and admin — so people see only the projects they were invited to. Connected apps act as the person who connected them and can only reach what that person can already reach.',
          'For organisations that must keep data and inference entirely on their own infrastructure, Digby can be self-hosted with your own model servers.',
        ],
        links: [{ href: '/ai-for-business', label: 'Digby for Canadian businesses' }],
      },
      {
        heading: 'Safe for the whole family',
        paragraphs: ['Kids accounts are created by a parent, run on a separate path with strict guardrails, and are never tracked by advertising or analytics tags.'],
        links: [{ href: '/digby-kids', label: 'About Digby Kids' }],
      },
      {
        heading: 'How Digby compares',
        paragraphs: [
          'Many popular assistants are run from the United States, and their Canadian storage options — where they exist — are usually limited to enterprise plans. With Digby, Canadian storage is the default for everyone, including guests, and the models that write answers run in Canada too.',
          'We compared Digby with the assistants Canadians use most, using each vendor’s own documentation.',
        ],
        links: [
          { href: '/digby-vs-chatgpt', label: 'Digby vs ChatGPT' },
          { href: '/digby-vs-microsoft-copilot', label: 'Digby vs Microsoft Copilot' },
        ],
      },
    ],
    faqs: [
      { q: 'Where is my data stored?', a: 'On servers in Canada — the Montréal, Canada Central region. That covers your account, conversations, memory and uploaded files.' },
      { q: 'Does my data leave Canada?', a: 'Stored data and the models that write answers stay in Canada. A web search sends the search query to a search service, a connected app (like Gmail) talks to that app, and the site’s analytics tags send usage data to Google and Meta — see section 7 of the privacy policy.' },
      { q: 'Does Digby train AI models on my chats?', a: 'No. Your conversations, memory and uploaded files are used only to answer you — never to train or fine-tune AI models.' },
      { q: PRICING_FAQ_QUESTION, a: pricingAnswer() },
      { q: 'Can I delete my data?', a: 'Yes. Delete individual conversations, review and delete memory facts, or request full account deletion.' },
      { q: 'Do I need an account?', a: 'No. Chat as a guest. An account keeps your history, memory and projects.' },
      { q: 'Can other people see my chats?', a: 'No, unless you share them. A share link is read-only and you can revoke it at any time; shared projects show only to the people you invite.' },
      { q: 'Should I put confidential work documents into Digby?', a: 'Digby stores files in Canada and keeps them private to your account or the projects you share them with. Follow your organisation’s rules — and for regulated or highly sensitive data, consider self-hosting so nothing leaves your own infrastructure.' },
    ],
    related: ['sovereign-ai', 'industries', 'compliance', 'learn/where-your-data-goes'],
  },
  {
    slug: 'sovereign-ai',
    group: 'canada',
    updated: '2026-10-16',
    alternate: { lang: 'fr-CA', slug: 'ia-souveraine-canada' },
    nav: 'Sovereign AI',
    title: 'Sovereign AI for Canada — open models on Canadian hardware',
    description: 'Sovereign AI for Canadians: open-weight models running on Canadian hardware, your data stored in Canada, and a self-hosted option for full control.',
    eyebrow: 'Sovereign AI · Canada',
    h1: 'Sovereign AI, built for Canada',
    lede: 'Sovereignty means Canadians decide where their data lives, which models they depend on, and who can switch them off. Digby is built around all three.',
    keywords: ['sovereign ai canada', 'sovereign canada ai models', 'canadian sovereign ai', 'canadian ai models', 'ai sovereignty canada'],
    secondary: { href: '/learn/what-is-sovereign-ai', label: 'Read the guide' },
    shot: 'answer',
    askPlaceholder: 'Ask about AI sovereignty…',
    card: 'Open-weight models on Canadian hardware, data in Canada, and a self-hosted option for full control.',
    prompts: ['Explain AI sovereignty in two sentences', 'Is residency the same as sovereignty?'],
    sections: [
      {
        heading: 'The three layers of AI sovereignty',
        bullets: [
          'Data — where conversations, files and memory are stored, and under which laws.',
          'Models — whether the intelligence you rely on is open and replaceable, or locked inside one vendor.',
          'Infrastructure — whether you could run the whole system yourself.',
        ],
        links: [{ href: '/learn/what-is-sovereign-ai', label: 'What is sovereign AI?' }],
      },
      {
        heading: 'Why it matters now',
        paragraphs: [
          'Most people in Canada use AI assistants that are built, hosted and governed elsewhere. That works until it doesn’t: a provider changes its terms, raises prices, retires the model your workflow was built on, or is subject to another country’s legal demands.',
          'Canada’s privacy commissioners have also started looking hard at how large AI services collect and use personal information. For individuals and organisations alike, knowing where your information goes — and being able to choose — is becoming part of using AI responsibly.',
        ],
        links: [{ href: '/infrastructure', label: 'Where the models actually run' }, { href: '/compliance', label: 'The frameworks and what we do not claim' }],
      
      },
      {
        heading: 'Data and models in Canada',
        paragraphs: ['Accounts, conversations, memory and files are kept in Montréal, and the models that write answers run on Canadian hardware. Residency alone isn’t sovereignty — so Digby covers models and infrastructure too.'],
        links: [{ href: '/ia-souveraine-canada', label: 'En français : l’IA souveraine au Canada' }],
      
      },
      {
        heading: 'Open-weight models, no lock-in',
        paragraphs: ['Open weights let Digby run custom-tuned models on Canadian hardware instead of renting a closed one from abroad. When a better open model is released, Digby can adopt it — no single company can change the terms underneath you.'],
        links: [{ href: '/open-source-ai', label: 'Why open models' }],
      },
      {
        heading: 'Full control when you need it',
        tone: 'inverse',
        paragraphs: ['Self-host the full stack — database, interface, integrations and coding workspace — and point it at models you run through any OpenAI-compatible endpoint: vLLM, Ollama, LM Studio and more.'],
        links: [{ href: '/self-hosted-ai', label: 'Self-hosted Digby' }],
      },
      {
        heading: 'A quick sovereignty check',
        bullets: [
          'Where is my data stored at rest — and where is it processed?',
          'Which models answer my questions, and can they be replaced?',
          'Who operates the servers, and under which country’s laws?',
          'Could we run it ourselves if we had to?',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The full checklist for organisations' }],
      },
      {
        heading: 'Who sovereign AI is for',
        bullets: [
          'Individuals — who would rather their conversations live in Canada and their assistant not depend on one foreign vendor.',
          'Businesses — that need to explain to customers and auditors where their data goes.',
          'Public sector, health and legal — where data, models and infrastructure may all need to stay under Canadian control.',
          'Researchers and builders — who want open models they can inspect, tune and run themselves.',
        ],
        links: [{ href: '/industries', label: 'AI shaped for Canadian industries' }, { href: '/industries-public-sector', label: 'AI for Canadian public bodies' }, { href: '/industries-legal', label: 'AI for Canadian law firms' }, { href: '/industries-first-nations', label: 'AI for First Nations administrations' }],
      
      },
    ],
    faqs: [
      { q: 'What does “sovereign AI” mean for Canada?', a: 'Canadians control where their data is stored, which models they depend on, and the infrastructure they run on — instead of relying entirely on one foreign platform.' },
      { q: 'Do Digby’s models run in Canada?', a: 'Yes. Digby runs custom-tuned open-weight models on Canadian hardware. You can also run models on your own hardware with self-hosted Digby.' },
      { q: 'Is data residency the same as sovereignty?', a: 'No. Residency is where data is stored. Sovereignty also covers who controls the models and the infrastructure.' },
      { q: 'Is Digby only for governments?', a: 'No. Anyone can use Digby. Organisations that need complete control can self-host it.' },
    ],
    related: ['private-ai', 'open-source-ai', 'infrastructure', 'learn/what-is-sovereign-ai'],
  },
  {
    slug: 'canadian-ai-chatbot',
    group: 'canada',
    updated: '2026-10-16',
    nav: 'Canadian AI chatbot',
    title: 'Canadian AI chatbot — Digby, the AI assistant made in Canada',
    description: 'A Canadian AI chatbot: Digby writes, researches and reads files with live web search and double-checked answers, and keeps your data in Canada.',
    eyebrow: 'Made in Canada',
    h1: 'The Canadian AI chatbot',
    lede: 'An AI chatbot built in Canada that keeps your conversations on Canadian soil. Ask anything, in English or French, and get answers that are researched, sourced and checked.',
    keywords: ['canada ai chatbot', 'canadian ai chatbot', 'canadian ai assistant', 'ai chatbot canada', 'best ai chatbot canada'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    shot: 'answer',
    askPlaceholder: 'Ask Digby anything…',
    card: 'Built in Canada, bilingual, with live web search and double-checked answers.',
    prompts: ['Explain the CRA rules for working from home', 'Plan a long weekend in Québec City'],
    sections: [
      {
        heading: 'What you can ask Digby',
        bullets: [
          'Write — emails, cover letters, reports and posts, in English or French.',
          'Research — current events, products, laws and regulations, with sources you can check.',
          'Understand documents — summarise a lease, compare insurance policies, pull numbers out of a spreadsheet.',
          'Plan — trips, budgets, study schedules, meal plans and business plans.',
          'Learn — explanations at any level, with follow-ups that go as deep as you want.',
        ],
        links: [{ href: '/chatgpt-alternative', label: 'Digby as a ChatGPT alternative in Canada' }, { href: '/about', label: 'Who builds Digby' }],
      
      },
      {
        heading: 'Built for Canadians',
        tone: 'inverse',
        bullets: [
          'Your conversations, memory and files are stored in Canada, and the AI runs on Canadian hardware.',
          'Ask about your province, taxes or local news, and Digby searches the live web for current sources.',
          'Bilingual: ask in English or French and get answers in the same language.',
        ],
        links: [
          { href: '/private-ai', label: 'Private AI for Canadians' },
          { href: '/ia-souveraine-canada', label: 'En français : l’IA souveraine au Canada' },
        ],
      },
      {
        heading: 'Smarter than a single model',
        paragraphs: [
          'Instead of one model guessing, Digby chooses the right model for each question, searches the web when facts are on the line, and has a second model check important answers.',
          'You can see the work: each answer lists the sources it used, and “How Digby answered” shows what happened behind it. If an answer matters, tap “Dig deeper” for an independent check or a full research pass.',
        ],
        links: [{ href: '/learn/how-digby-double-checks-answers', label: 'How Digby double-checks answers' }],
      },
      {
        heading: 'Questions Canadians ask Digby',
        chips: ['TFSA vs RRSP', 'Tenant rights', 'EI and parental leave', 'Heat-pump rebates', 'Moving provinces', 'Small-business taxes', 'Road-trip planning', 'French homework'],
        paragraphs: ['For anything that changes — rules, rates, rebates, prices — Digby looks up current sources instead of relying on what a model memorised.'],
      },
      {
        heading: 'No account needed to start',
        paragraphs: ['Open digby.example.com and ask. An account keeps your history, memory and projects across devices; heavier features such as deep research have daily limits.'],
        links: [{ href: '/digby-vs-chatgpt', label: 'Digby vs ChatGPT' }],
      },
      {
        heading: 'English and French, side by side',
        paragraphs: ['Write to Digby in either official language and it answers in kind. Ask it to translate between them, to adapt a message for a Québec audience, or to draft the same notice in both languages at once — useful for workplaces, schools and community groups across the country.'],
        links: [{ href: '/ia-souveraine-canada', label: 'Lire en français' }],
      },
      {
        heading: 'Getting better answers',
        bullets: [
          'Say where you are — rules for taxes, tenancy and benefits differ by province.',
          'Ask for sources — Digby will search and cite what it found.',
          'Attach the document — a lease, a policy or a statement beats a description of it.',
          'Tap “Dig deeper” — for anything you’ll act on, get an independent check or a research pass.',
        ],
        links: [{ href: '/faq', label: 'The short answers to common questions' }, { href: '/learn/choosing-a-private-ai-chatbot', label: 'How to judge a private AI chatbot' }, { href: '/deep-research', label: 'When a question deserves deep research' }, { href: '/digby-kids', label: 'A safe AI tutor for children' }],
      
      },
    ],
    faqs: [
      { q: 'Is Digby a Canadian company?', a: 'Digby is built in Canada and stores its users’ accounts, conversations and files in Canada.' },
      { q: 'Does Digby speak French?', a: 'Yes. Ask in French and Digby answers in French.' },
      { q: PRICING_FAQ_QUESTION, a: pricingAnswer() },
      { q: 'Is Digby on my phone?', a: 'Yes. Open digby.example.com and add it to your home screen on iPhone or Android; there are also desktop apps for macOS and Windows.' },
    ],
    related: ['industries', 'private-ai', 'digby-vs-chatgpt', 'learn/choosing-a-private-ai-chatbot'],
  },
  {
    slug: 'chatgpt-alternative',
    group: 'canada',
    updated: '2026-10-16',
    nav: 'ChatGPT alternative',
    title: 'A Canadian ChatGPT alternative — private, checked, open',
    description: 'A Canadian alternative to ChatGPT: open-weight models on Canadian hardware, data stored in Canada, live web search with sources and checked answers.',
    eyebrow: 'ChatGPT alternative · Canada',
    h1: 'A Canadian alternative to ChatGPT',
    lede: 'The same everyday power — writing, research, files, code — with Canadian data storage, models on Canadian hardware, and answers that are checked, not just generated.',
    keywords: ['chatgpt alternative canada', 'canadian chatgpt', 'chatgpt alternative', 'canadian alternative to chatgpt', 'ai chatbot alternative'],
    secondary: { href: '/digby-vs-chatgpt', label: 'Side-by-side comparison' },
    shot: 'sources',
    askPlaceholder: 'Ask your first question…',
    card: 'Writing, research, files and code — with Canadian storage and checked answers.',
    prompts: ['How are you different from ChatGPT?', 'Rewrite this email to sound more confident'],
    sections: [
      {
        heading: 'How Digby is different',
        bullets: [
          'Canadian end to end — models run on Canadian hardware; your account, chats, memory and files are stored in Canada.',
          'Many open models — not one closed model; Digby picks the best fit for each question.',
          'Checked answers — on contested or high-stakes questions a second model independently reviews the answer.',
          'Research councils — several models research in parallel and Digby writes one sourced report.',
          'Self-hostable — organisations can run the whole thing on their own servers.',
        ],
        links: [{ href: '/digby-vs-chatgpt', label: 'Digby vs ChatGPT, side by side' }],
      },
      {
        heading: 'Everything you expect from an AI assistant',
        chips: ['Writing & editing', 'Translation', 'Web search with citations', 'PDFs & spreadsheets', 'Images', 'Voice', 'Memory', 'Projects', 'Coding agent'],
        paragraphs: ['Digby covers the everyday work people use ChatGPT for — drafting and editing, summarising documents, answering questions with sources, brainstorming and planning — plus a coding agent and integrations with the tools you already use.'],
        links: [{ href: '/features', label: 'Full feature list' }],
      },
      {
        heading: 'Why Canadians switch',
        paragraphs: [
          'Some want their conversations stored in Canada rather than the United States. Some want answers that show their sources and get a second opinion. Some don’t want the intelligence their work depends on to come from a single closed vendor.',
          'Whatever the reason, the test is the same: try your own questions. You don’t need an account to start.',
        ],
        links: [{ href: '/about', label: 'Who builds Digby' }, { href: '/industries', label: 'AI for Canadian industries' }],
      
      },
      {
        heading: 'Switching is easy',
        tone: 'inverse',
        paragraphs: ['There is nothing to install and no account required. Open digby.example.com, ask your first question, and create an account when you want to keep your history. Tell Digby what to remember about you and it will.'],
        links: [{ href: '/canadian-ai-chatbot', label: 'The Canadian AI chatbot' }],
      },
      {
        heading: 'An honest trade-off',
        paragraphs: [
          'ChatGPT has a huge ecosystem and features that only OpenAI’s models offer. Digby’s bet is different: many open models instead of one closed one, Canadian storage and processing for every user, and answers that are checked and sourced rather than simply generated.',
          'For most everyday work — writing, research, documents, planning and code — that bet holds up well. Try the questions you actually ask and judge for yourself.',
        ],
        links: [{ href: '/learn/open-weight-vs-closed-ai-models', label: 'Open-weight vs closed models' }],
      },
    ],
    faqs: [
      { q: 'Is Digby better than ChatGPT?', a: 'It depends on what you value. Digby focuses on Canadian data storage, open-weight models without single-vendor lock-in, and cross-checked answers. Try both on your own questions, and start without an account.' },
      { q: 'Can I use Digby without an account?', a: 'Yes. Guests can chat right away; an account saves your conversations and memory.' },
      { q: 'Can I bring my ChatGPT memory to Digby?', a: 'Tell Digby the facts you want it to remember — or paste them in — and it saves them to your memory, where you can review and edit them.' },
    ],
    related: ['digby-vs-chatgpt', 'canadian-ai-chatbot', 'open-source-ai', 'learn/open-weight-vs-closed-ai-models'],
  },
  {
    slug: 'open-source-ai',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Open models',
    title: 'Open-source AI chat — custom-tuned open models',
    description: 'Digby is built on custom-tuned open-weight models running on Canadian hardware. It picks the best one per question and cross-checks the answers that matter.',
    eyebrow: 'Open models',
    h1: 'Built on open models, not one black box',
    lede: 'Digby runs on leading open-weight models, picks the best one for each question, and cross-checks the answers that matter.',
    keywords: ['open source ai chatbot', 'open weight ai models', 'kimi ai', 'glm ai', 'deepseek chat', 'qwen chat', 'open source chatgpt alternative'],
    secondary: { href: '/deep-research', label: 'Deep research' },
    askPlaceholder: 'Ask about the models…',
    card: 'Custom-tuned open models — the best one per question, cross-checked.',
    prompts: ['Which model answered this?', 'Open vs closed models in one paragraph'],
    sections: [
      {
        heading: 'Custom-tuned open models',
        paragraphs: ['Digby starts from leading open-weight models and tunes them for accuracy, safety and the way Canadians work. Open weights mean Digby can run them on Canadian hardware — and you can run them on yours.'],
      },
      {
        heading: 'The right model per question',
        paragraphs: [
          'Writing, reasoning, code and research each favour different models. Digby routes every question to the one best suited to it, and a quick question doesn’t wait on a heavyweight model.',
          'The lineup changes as better open models are released. Because they are open, adopting a new one is a configuration change — not a new contract.',
        ],
        links: [{ href: '/learn/open-weight-vs-closed-ai-models', label: 'Open-weight vs closed models' }],
      },
      {
        heading: 'A second opinion, built in',
        tone: 'inverse',
        paragraphs: ['On contested or high-stakes questions an independent model checks the first answer before you rely on it. If it finds a real problem, the answer is updated and you can see what changed.'],
        links: [{ href: '/learn/how-digby-double-checks-answers', label: 'How the double-check works' }],
      },
      {
        heading: 'No lock-in',
        paragraphs: ['No single company can change prices, terms or availability underneath you. Self-hosted Digby works with any OpenAI-compatible model server.'],
        links: [
          { href: '/sovereign-ai', label: 'Sovereign AI' },
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
        ],
      },
    ],
    faqs: [
      { q: 'Which open models does Digby use?', a: 'Custom-tuned open-weight models from several leading labs, chosen per question. The lineup is updated as better open models are released.' },
      { q: 'Are open models as good as ChatGPT?', a: 'The best open-weight models are now competitive with leading closed models on many tasks. Combining several of them — and checking one with another — closes much of the remaining gap.' },
      { q: 'What does “open-weight” mean?', a: 'The model’s trained weights are published, so anyone with suitable hardware can run it — a Canadian data centre, a cloud provider or your own server.' },
    ],
    related: ['learn/open-weight-vs-closed-ai-models', 'sovereign-ai', 'digby-vs-augure-ai', 'self-hosted-ai'],
  },
  {
    slug: 'ai-for-business',
    group: 'canada',
    updated: '2026-10-16',
    nav: 'AI for business',
    title: 'AI for Canadian businesses — private, Canadian-hosted',
    description: 'AI Canadian businesses can rely on: models on Canadian hardware, data stored in Canada, sourced and cross-checked answers, shared projects and self-hosting.',
    eyebrow: 'For Canadian businesses',
    h1: 'AI your Canadian business can rely on',
    lede: 'Your team already uses AI. Digby gives it a home that keeps company information in Canada, produces answers you can verify, and plugs into the tools you already use.',
    keywords: ['ai for canadian business', 'canadian business ai assistant', 'ai data residency canada', 'secure ai for business canada', 'enterprise ai canada'],
    secondary: { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
    shot: 'integrations',
    askPlaceholder: 'Ask how Digby fits your team…',
    card: 'Canadian storage, verifiable answers, shared projects and a self-hosted option.',
    prompts: ['Draft an AI-use policy for a 20-person firm', 'Summarise our handbook into an FAQ'],
    sections: [
      {
        heading: 'Why Canadian businesses choose Digby',
        bullets: [
          'Canadian by default — models on Canadian hardware; accounts, chats, memory and files stored in Canada.',
          'Verifiable — answers with sources, and independent cross-checks on high-stakes questions.',
          'Shared projects — roles (viewer, editor, admin), shared instructions and a knowledge base.',
          'Connected — Google Workspace, Slack, Asana, Xero, GitHub and more.',
          'Self-hostable — for organisations that need complete control.',
        ],
      },
      {
        heading: 'Put your documents to work',
        paragraphs: [
          'Upload policies, contracts, manuals and spreadsheets into a project and Digby answers from them with the relevant passages — so everyone gets the same, grounded answer.',
          'Give a project its own instructions — your tone of voice, your product names, the rules a reply must follow — and every chat in that project starts from them.',
        ],
      },
      {
        heading: 'Automate the routine',
        tone: 'inverse',
        paragraphs: ['Schedule daily briefings, recurring research and follow-ups. Connect your inbox and calendar so Digby can draft replies and prepare meetings. Developers can hand tickets to Digby Code, which works in a real workspace and opens pull requests.'],
        links: [
          { href: '/integrations', label: 'Integrations with your tools' },
          { href: '/ai-coding-agent', label: 'Digby Code' },
        ],
      },
      {
        heading: 'How teams roll it out',
        bullets: [
          'Start small — one team, one or two projects, the documents they already rely on.',
          'Write it down — a short AI-use policy: what goes in, what stays out, who reviews outputs.',
          'Connect deliberately — add integrations one at a time, scoped to the people who need them.',
          'Review — check sources on important answers and use “Dig deeper” for anything that will be published or signed.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }],
      },
      {
        heading: 'Questions to ask any AI vendor',
        paragraphs: ['Where is our data stored? Which models process it? Can we delete it? Can we leave? We wrote a practical checklist for Canadian organisations — and compared Digby with the tools you are probably weighing.'],
        links: [
          { href: '/digby-vs-microsoft-copilot', label: 'Digby vs Microsoft Copilot' },
          { href: '/digby-vs-cohere-north', label: 'Digby vs Cohere North' },
        ],
      },
      {
        heading: 'Where teams use it',
        chips: ['Customer emails', 'Policy Q&A', 'Proposal drafts', 'Meeting prep', 'Market research', 'Bookkeeping questions', 'Code reviews', 'Onboarding guides'],
        paragraphs: ['The pattern is the same everywhere: give Digby the documents and tools the work already uses, then let people ask in plain language and check the sources behind each answer.'],
        links: [{ href: '/industries-legal', label: 'AI for Canadian law firms' }, { href: '/industries-healthcare', label: 'AI for Canadian clinics' }, { href: '/industries-credit-unions', label: 'AI for Canadian credit unions' }, { href: '/industries-first-nations', label: 'AI for First Nations administrations' }, { href: '/industries-manufacturing', label: 'AI for Canadian manufacturers' }],
      
      },
    ],
    faqs: [
      { q: 'Is Digby compliant with Canadian privacy law?', a: 'Digby stores data in Canada and gives users control to view and delete it, but we do not claim any certification. Every organisation should assess its own obligations under PIPEDA and provincial laws such as Québec’s Law 25.' },
      { q: 'Can we self-host Digby?', a: 'Yes. Digby can run on your own server with Docker Compose and your own model endpoints.' },
      { q: 'Can several people work in the same project?', a: 'Yes. Invite teammates as viewers, editors or admins; they share the project’s chats, instructions and knowledge base.' },
    ],
    related: ['industries', 'compliance', 'self-hosted-ai', 'learn/ai-at-work-in-canada-checklist'],
  },
  {
    slug: 'industries',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Industries',
    title: 'AI for Canadian industries — private by default',
    description: 'Private AI for Canadian industries: models on Canadian hardware, data in Canada, and sector setups for legal, health, finance and the public sector.',
    eyebrow: 'Industries · Canada',
    h1: 'AI for Canadian industries',
    lede: 'One assistant, shaped around the work each sector actually does — with your data stored in Canada and the models answering on Canadian hardware.',
    keywords: ['ai for canadian industries', 'private ai by industry canada', 'industry ai canada', 'sector specific ai canada', 'canadian ai for regulated industries'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    askPlaceholder: 'Ask which setup fits your sector…',
    card: 'Six sector setups on one Canadian assistant — data in Canada, models on Canadian hardware.',
    prompts: ['Which sector setup fits my team?', 'What is the same across every sector?'],
    sections: [
      {
        heading: 'Why a sector page instead of a generic “AI” page',
        paragraphs: [
          'Most AI marketing says the same thing to everyone. The work does not: a paralegal asks about a matter file, a clinic manager asks about a policy, a plant supervisor asks about a lockout procedure, and each of them needs an answer that cites the document it came from.',
          'So the pages below take the same Canadian foundation and describe what it looks like in one sector at a time — the documents people load first, the questions they ask most, the obligations they have to respect, and the parts of Digby that do the work.',
        ],
      },
      {
        heading: 'Pick your sector',
        links: [
          { href: '/industries-legal', label: 'Legal — contract review support and matter-file Q&A' },
          { href: '/industries-healthcare', label: 'Healthcare — clinic policy Q&A, not a clinical device' },
          { href: '/industries-credit-unions', label: 'Credit unions — member service, policy and regulator framing' },
          { href: '/industries-public-sector', label: 'Public sector — procurement answers and bilingual service' },
          { href: '/industries-manufacturing', label: 'Manufacturing — procedures, maintenance and quality standards' },
          { href: '/industries-first-nations', label: 'First Nations — community-controlled data and hosting' },
        ],
        paragraphs: ['The six are the sectors we are asked about most. Nothing about Digby is limited to them — a museum, a charity or a surveying firm can use exactly the same projects, knowledge base and scheduled briefings.'],
      },
      {
        heading: 'The same foundation underneath every sector',
        tone: 'inverse',
        paragraphs: ['Accounts, conversations, memory and uploaded files are stored in Canada (the Canada Central region in Montréal). The models that write answers run on Canadian hardware. Your content is never used to train or fine-tune AI models. And an organisation that needs the whole stack inside its own walls can self-host Digby with its own model server.'],
        links: [
          { href: '/compliance', label: 'What Digby does — and does not — claim' },
          { href: '/infrastructure', label: 'Where the models actually run' },
        ],
      },
      {
        heading: 'What every sector setup starts from',
        bullets: [
          'Projects with a knowledge base — load the policies, manuals, contracts or standards a team works from, and answers come back with the passages they came from.',
          'Files you already have — PDFs, Word documents, spreadsheets and images are read directly; a scanned page is read from the page image.',
          'Scheduled briefings — a daily or weekly summary of what changed in the documents or inbox a team watches.',
          'Connected tools — Gmail, Google Drive and Calendar, Slack, Asana, Xero, GitHub, Discord, Telegram and iMessage, each acting as the person who connected it.',
          'A second opinion — contested or high-stakes answers get an independent model check, and “Dig deeper” escalates anything you are about to sign or publish.',
        ],
        links: [{ href: '/integrations', label: 'See the integrations' }],
      },
      {
        heading: 'Regulated work needs a paper trail',
        paragraphs: [
          'The questions regulators, auditors and procurement teams ask are almost always the same: where is it stored, where is it processed, can we delete it, and can you show us the source of an answer. Digby answers the first three with a location and a delete button, and the fourth with citations on every grounded answer.',
          'What Digby does not have is a certification to hand you. We hold no PIPEDA, Law 25, PHIPA or SOC 2 certificate, and the compliance page says so plainly rather than implying otherwise.',
        ],
        links: [
          { href: '/compliance', label: 'Compliance in plain language' },
          { href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' },
          { href: '/ai-legal-toronto', label: 'AI for law firms in Toronto' },
          { href: '/ai-legal-victoria', label: 'AI for law firms in Victoria' },
        ],
      },
      {
        heading: 'Hosted today, self-hosted when you need it',
        paragraphs: [
          'Almost every sector starts hosted: open digby.example.com, create a project, upload the documents and invite the team. No deployment project, no procurement cycle.',
          'When the requirement is genuinely “nothing leaves our building”, the same product runs on your own server with Docker Compose and any OpenAI-compatible model endpoint — vLLM, Ollama or LM Studio on your own GPUs.',
        ],
        links: [
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
          { href: '/ai-for-business', label: 'AI for Canadian businesses' },
        ],
      },
    ],
    faqs: [
      { q: 'Which industries does Digby work for?', a: 'Any organisation that reads documents and writes answers. The six dedicated setups are legal, healthcare, credit unions and financial services, public sector, manufacturing and First Nations administrations — each page describes the documents, questions and obligations of that sector.' },
      { q: 'Is the AI different per sector?', a: 'The underlying assistant is the same. What changes is the project setup — the knowledge base, the instructions a project follows (tone, product names, rules a reply must respect) and the tools connected to it.' },
      { q: 'Where is our data stored?', a: 'In Canada — the Canada Central region in Montréal — covering accounts, conversations, memory and uploaded files.' },
      { q: 'Do the models run in Canada?', a: 'Yes. Digby’s models are served on Canadian-located GPU hardware. A connected app (Gmail, Slack) still talks to that app, and a web search still sends the query to a search service.' },
      { q: 'Does Digby train on our documents?', a: 'No. Your conversations, memory and uploaded files are never used to train or fine-tune AI models.' },
      { q: 'Can we keep everything on our own infrastructure?', a: 'Yes. Self-hosted Digby runs the full stack — database, interface, integrations and coding workspace — on your servers with your own model endpoints.' },
      { q: 'Is Digby certified for regulated industries?', a: 'No. Digby holds no PIPEDA, Law 25, PHIPA or SOC 2 certification, and we do not describe it as compliant. What we can show is where data lives, where inference runs, how deletion works and where each answer came from.' },
    ],
    related: ['private-ai', 'compliance', 'infrastructure', 'ai-for-business'],
  },
  {
    slug: 'industries-legal',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Legal',
    title: 'AI for Canadian law firms and legal teams',
    description: 'Private AI for Canadian legal teams: matter-file Q&A with cited passages, contract review support, precedent research with sources, and data stored in Canada.',
    eyebrow: 'Industries · Legal',
    h1: 'AI for Canadian law firms and legal teams',
    lede: 'Ask a matter file a question and get the passage back. Digby reads the contracts, precedents and policies a firm already works from — and stores the work in Canada.',
    keywords: ['ai for lawyers canada', 'legal ai canada', 'private ai law firm canada', 'contract review ai canada', 'ai for canadian law firms', 'legal document ai canada'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    askPlaceholder: 'Ask about a matter or a clause…',
    card: 'Matter-file Q&A with cited passages, contract review support and precedent research — data in Canada.',
    prompts: ['Summarise this agreement’s termination clause', 'What does our retainer policy say about disbursements?'],
    sections: [
      {
        heading: 'What it does for a legal team',
        bullets: [
          'Matter-file Q&A — upload the disclosure, the correspondence and the expert report to a project, then ask in plain language and get the passage that answers it.',
          'Contract review support — flag unusual clauses, compare a draft against your firm’s standard form, and list what changed between two versions.',
          'Precedent research with sources — Digby searches the live web when facts are current, cites what it found, and a different model checks the answers that matter.',
          'Policy and know-how Q&A — the firm manual, the conflicts policy, the billing guidelines, in one place everyone can ask.',
          'Drafting from a template — a first-pass memo, a client update letter or a chronology, written in your voice from the project’s instructions.',
        ],
      },
      {
        heading: 'A project per matter',
        paragraphs: [
          'Each matter gets its own project: its own documents, its own instructions, its own people. Invite the associate and the paralegal as editors, the student as a viewer, and nothing crosses into another matter.',
          'Project instructions carry the firm’s rules — the tone of a client update, the defined terms you always use, the sentences a reply must never contain — so every draft in that matter starts from them.',
        ],
        links: [{ href: '/features', label: 'Projects, memory and knowledge base' }],
      },
      {
        heading: 'Confidentiality, in plain terms',
        tone: 'inverse',
        paragraphs: ['Your documents are stored in Canada and processed by models served on Canadian hardware, and they are never used to train or fine-tune AI models. Memory is visible and deletable; conversations can be deleted one at a time or all at once; share links are opt-in and revocable. A firm that must keep everything inside its own network can self-host the full stack.'],
        links: [
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
          { href: '/compliance', label: 'Compliance in plain language' },
        ],
      },
      {
        heading: 'Where a lawyer still has to be the lawyer',
        paragraphs: [
          'Digby drafts and summarises; it does not advise. Every output is a first pass that a licensee reviews, verifies and takes responsibility for — the same way a junior’s memo is reviewed before it leaves the firm.',
          'That matters for professional obligations too. Law societies across Canada have been clear that lawyers remain responsible for the work product and for client confidentiality, whatever tools they use. Nothing here changes a firm’s own obligations, and nothing on this page is legal advice.',
        ],
      },
      {
        heading: 'A sensible first month',
        bullets: [
          'Start with know-how, not matters — put the firm manual and the standard forms in a project and let people ask questions about their own procedures first.',
          'Then one closed matter — a file that is already resolved, so the team can check Digby’s answers against the record.',
          'Write the rule down — what may go in, what never does, who reviews an output before it is used.',
          'Then open it up — new matters, with a reviewer named for anything client-facing.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }, { href: '/ai-legal-calgary', label: 'AI for law firms in Calgary' }],
      },
      {
        heading: 'Bilingual client service',
        paragraphs: ['Ask in French and the answer comes back in French; ask in English and it does too. For firms serving clients in both languages, a project can hold both versions of a document and answer from either.'],
      },
    ],
    faqs: [
      { q: 'Is Digby a legal advice tool?', a: 'No. Digby drafts, summarises and finds passages. A licensee reviews every output and remains responsible for it. Nothing Digby produces is legal advice.' },
      { q: 'Can I put client documents into Digby?', a: 'Many firms do, in a project scoped to that matter. Your files are stored in Canada, processed by models on Canadian hardware, and never used to train AI models. Whether a given document may go into any third-party tool is a decision for the firm under its own confidentiality and client obligations.' },
      { q: 'Can Digby cite where an answer came from?', a: 'Yes. Answers grounded in your uploaded documents point back to the passages they used, and research answers cite the pages Digby read.' },
      { q: 'Can we keep client data out of the cloud entirely?', a: 'Yes — self-host Digby on your own servers with your own model endpoints, so documents and inference stay inside the firm’s network.' },
      { q: 'Does Digby work in French?', a: 'Yes. Digby answers in the language it is asked in, and reads French documents as readily as English ones.' },
      { q: 'What should we not use it for?', a: 'Anything requiring legal judgement without review: final advice to a client, a limitation-period calculation you have not verified, or a citation you have not opened and read.' },
    ],
    related: ['industries', 'compliance', 'private-ai', 'ai-for-business'],
  },
  {
    slug: 'industries-healthcare',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Healthcare',
    title: 'AI for Canadian clinics and healthcare teams',
    description: 'PHIPA-aware AI for Canadian clinics: policy Q&A with cited passages, patient-adjacent admin work, data stored in Canada. Not a clinical device.',
    eyebrow: 'Industries · Healthcare',
    h1: 'AI for Canadian clinics and healthcare teams',
    lede: 'The clinic handbook, the infection-control policy, the rostering rules — ask them in plain language and get the paragraph back. Digby is an admin assistant, not a clinical device.',
    keywords: ['ai for healthcare canada', 'phipa ai canada', 'private ai for clinics canada', 'healthcare ai canada', 'clinic policy ai canada', 'canadian health ai assistant'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    askPlaceholder: 'Ask about a clinic policy…',
    card: 'Policy and procedure Q&A with cited passages, admin work support, data in Canada — not a clinical device.',
    prompts: ['What does our infection-control policy say about hand hygiene audits?', 'Draft a letter reminding patients about their annual review'],
    sections: [
      {
        heading: 'What it does for a clinic or health team',
        bullets: [
          'Policy and procedure Q&A — the clinic manual, the infection-control policy, the privacy policy, the accreditation standards: uploaded once, asked about endlessly, answered with the passage.',
          'Patient-adjacent admin — appointment reminders, referral letters, patient-education handouts, staff rosters and job descriptions.',
          'Onboarding a locum — a new physician or nurse asks the ten questions everyone asks in week one and gets answers from the clinic’s own documents.',
          'Scheduled briefings — a Monday summary of what changed in the policies a manager watches, or a weekly digest of the inbox.',
          'Bilingual patient materials — plain-language handouts written in English or French, at the reading level you ask for.',
        ],
      },
      {
        heading: 'What Digby is not',
        paragraphs: [
          'Digby is not a medical device, not a diagnostic tool, and not a clinical decision support system. It does not interpret tests, does not triage patients and does not give treatment recommendations. Nothing it produces is clinical advice.',
          'The line we keep: it works on the paperwork around care — the policies, the letters, the schedules, the training material — and never on the clinical judgement itself.',
        ],
      },
      {
        heading: 'PHIPA awareness, stated honestly',
        paragraphs: [
          'Ontario’s health privacy law, PHIPA, and the equivalent provincial health statutes set rules for personal health information: who may collect it, where it may be used, who is accountable. Digby stores data in Canada and gives you the controls a privacy officer will ask about — but we do not claim PHIPA certification, because there is no such certificate to hold.',
          'Whether a particular document may go into an AI tool is a decision for the clinic’s privacy officer and custodian, under their own policy. A common and sensible line: policies, procedures and templates go in; identified patient records stay in the clinical system.',
        ],
        links: [{ href: '/compliance', label: 'Compliance in plain language' }],
      },
      {
        heading: 'Clinic-controlled infrastructure',
        tone: 'inverse',
        paragraphs: ['A clinic that must keep everything on its own network can run the full Digby stack on its own server with its own model endpoints — documents never leave the building and inference happens on hardware the clinic controls. Hosted Digby is the same product with Canadian storage and models served on Canadian hardware.'],
        links: [{ href: '/self-hosted-ai', label: 'Self-hosted Digby' }],
      },
      {
        heading: 'The controls a privacy officer asks about',
        bullets: [
          'Storage — accounts, conversations, memory and files live in the Canada Central region in Montréal.',
          'Inference — the models that write answers are served on Canadian-located GPU hardware.',
          'Training — your content is never used to train or fine-tune AI models.',
          'Memory — every fact Digby remembers is visible, editable and deletable, and conversations can be deleted individually or wholesale.',
          'Sharing — nothing is visible to anyone unless a share link is created, and every link can be revoked.',
          'Access — projects use viewer, editor and admin roles, so people see only the projects they were invited to.',
        ],
      },
      {
        heading: 'A sensible first month',
        paragraphs: [
          'Start with the documents nobody argues about: policies, procedures, the staff handbook, accreditation standards. Let the team ask questions about their own procedures before anything patient-adjacent is involved.',
          'Then add drafting work — letters, handouts, rosters — with a named reviewer. Keep identified patient information in the clinical system unless the clinic’s privacy officer has decided otherwise in writing.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }, { href: '/ai-healthcare-toronto', label: 'AI for clinics in Toronto' }, { href: '/ai-healthcare-montreal', label: 'AI for clinics in Montréal' }],
      },
    ],
    faqs: [
      { q: 'Is Digby a medical device?', a: 'No. Digby is a general-purpose assistant used for administrative and policy work. It is not a medical device, does not diagnose, does not triage and does not support clinical decisions.' },
      { q: 'Can we use it with patient information?', a: 'Digby stores data in Canada and gives you deletion, memory and sharing controls, but whether identified patient information may enter any AI tool is a decision for your privacy officer under PHIPA or your provincial health law. Many clinics keep patient records in the clinical system and use Digby for policies, procedures and templates.' },
      { q: 'Is Digby PHIPA compliant?', a: 'We do not claim compliance or certification — no such certificate exists to hold. Digby is designed to support a clinic’s own PHIPA obligations: Canadian storage, Canadian inference, no training on your content, visible and deletable memory, and revocable sharing.' },
      { q: 'Can we run it inside the clinic?', a: 'Yes. Self-hosted Digby runs on the clinic’s own server with its own model endpoints through Docker Compose.' },
      { q: 'Does it read scanned documents?', a: 'Yes. PDFs, Word documents, spreadsheets and images are read directly, and a scanned page is read from the page image by the document reader.' },
      { q: 'Who can see a project?', a: 'Only the people invited to it, as viewers, editors or admins. Connected apps act as the person who connected them and can only reach what that person can reach.' },
    ],
    related: ['industries', 'compliance', 'private-ai', 'ai-for-business'],
  },
  {
    slug: 'industries-credit-unions',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Credit unions',
    title: 'AI for credit unions and Canadian financial teams',
    description: 'Private AI for Canadian credit unions: policy and compliance Q&A, member-service drafting, audit-friendly trails, data stored in Canada and a self-host path.',
    eyebrow: 'Industries · Credit unions',
    h1: 'AI for Canadian credit unions',
    lede: 'Member letters, lending policy, board packages, regulator questions — the paperwork a credit union runs on, with answers that cite the policy they came from.',
    keywords: ['ai for credit unions canada', 'osfi e-23 ai', 'private ai financial services canada', 'credit union ai canada', 'ai for canadian banks', 'financial services ai canada'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    askPlaceholder: 'Ask about a policy or a member letter…',
    card: 'Policy Q&A, member-service drafting and audit-friendly trails — data stored in Canada.',
    prompts: ['Draft a member letter explaining a rate change', 'What does our lending policy say about co-signers?'],
    sections: [
      {
        heading: 'What it does for a credit union',
        bullets: [
          'Policy and compliance Q&A — the lending policy, the deposit policy, the privacy code, the board’s governance manual: ask in plain language, get the clause.',
          'Member-service drafting — rate-change notices, hardship responses, complaint acknowledgements, branch announcements, in the tone the credit union uses.',
          'Staff enablement — a new member-service rep asks the questions a mentor would otherwise answer five times a day, and gets answers grounded in the current policy rather than last year’s PDF.',
          'Board and committee prep — a plain-language summary of a long policy document, with the sections that changed called out.',
          'Regulator and audit questions — turn an examiner’s information request into a short index of where each answer lives in your own documents.',
        ],
      },
      {
        heading: 'OSFI E-23 and provincial regulators',
        paragraphs: [
          'Federally regulated institutions work under OSFI’s Guideline E-23 on model risk management, which asks an institution to inventory its models, understand their limitations and govern their use. Provincially regulated credit unions answer to their own provincial regulator and to provincial privacy law.',
          'Digby is not a credit-scoring or decisioning model, and it should not be used to make lending decisions. Where it helps is the documentation around those models: explaining a policy, drafting a member communication, summarising a guideline, and keeping the source passage attached to the answer.',
          'We do not claim that using Digby satisfies E-23 or any regulator’s expectations. It gives you the artifacts — the cited source, the recorded policy version, the deletion controls — that make your own assessment easier to evidence.',
        ],
        links: [{ href: '/compliance', label: 'Compliance in plain language' }],
      },
      {
        heading: 'Controls a risk committee will ask about',
        tone: 'inverse',
        paragraphs: ['Accounts, conversations, memory and files are stored in Canada (Canada Central, Montréal) and processed by models served on Canadian-located GPU hardware. Your content is never used to train or fine-tune AI models. Memory and conversations are visible and deletable. Share links are opt-in and revocable, and nothing is visible outside a project unless someone creates one.'],
        links: [
          { href: '/infrastructure', label: 'Where the models run' },
          { href: '/learn/canadian-data-residency-ai', label: 'Data residency for Canadian organisations' },
        ],
      },
      {
        heading: 'Keeping member information where it belongs',
        paragraphs: [
          'Most credit unions land in the same place: policies, procedures, product documentation and internal templates go into a project; identified member records stay in the core system. That keeps the useful part of the tool — the institutional knowledge — while leaving the member file where the record of record lives.',
          'Where a project does hold sensitive material, roles keep it narrow: viewers read, editors work, admins manage, and only the people invited see the project at all.',
        ],
      },
      {
        heading: 'Self-hosted when the requirement is absolute',
        paragraphs: [
          'Some institutions have a hard requirement that no document and no prompt leaves infrastructure they operate. Self-hosted Digby runs the full stack — database, interface, integrations and coding workspace — on your own servers with your own OpenAI-compatible model endpoints.',
          'The same product, the same interface, the same projects; only the operator changes. It is a real option, not a press release.',
        ],
        links: [{ href: '/self-hosted-ai', label: 'Self-hosted Digby' }],
      },
      {
        heading: 'A sensible first month',
        bullets: [
          'One policy area — pick the one staff ask about most and load it, with its current version date in the document name.',
          'One drafting workflow — member letters or branch announcements, reviewed by the person who signs them today.',
          'One rule written down — what may go in, what never does, and who reviews an output before a member sees it.',
          'One review — after a month, read a sample of answers against the policy and see whether the cited passages held up.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }],
      },
    ],
    faqs: [
      { q: 'Does Digby make lending or credit decisions?', a: 'No. Digby is not a credit-scoring or decisioning system, and it should not be used to approve, decline or price credit. It works on policy Q&A, drafting and summarisation.' },
      { q: 'Is Digby OSFI E-23 compliant?', a: 'We do not claim compliance with E-23 or any regulator’s expectations. E-23 asks institutions to govern model risk themselves; Digby can support the documentation side by keeping cited sources, policy versions and deletion controls, and your own assessment remains yours to make.' },
      { q: 'Where is member information stored?', a: 'Anything you put into Digby is stored in Canada — the Canada Central region in Montréal — and processed by models on Canadian-located GPU hardware. Many credit unions keep member records in the core system and use Digby for policies and drafting instead.' },
      { q: 'Can we delete something we uploaded by mistake?', a: 'Yes. Files, conversations and individual memory facts can be removed, and share links can be revoked.' },
      { q: 'Can we run it on our own infrastructure?', a: 'Yes. Self-hosted Digby runs on your servers with your own model endpoints, so documents and inference stay inside the environment you operate.' },
      { q: 'Does Digby support French service?', a: 'Yes. Ask in French and the answer comes back in French, and French documents are read as readily as English ones — useful for member communications in bilingual regions.' },
    ],
    related: ['industries', 'compliance', 'private-ai', 'ai-for-business'],
  },
  {
    slug: 'industries-public-sector',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Public sector',
    title: 'AI for Canadian public sector teams',
    description: 'AI for Canadian municipalities, agencies and public bodies: data stored in Canada, models on Canadian hardware, bilingual service and procurement-ready answers.',
    eyebrow: 'Industries · Public sector',
    h1: 'AI for Canadian public sector teams',
    lede: 'Municipal clerks, agency program staff and policy teams can get straight answers about where the data lives, where the inference runs, and who can delete it.',
    keywords: ['ai for public sector canada', 'government ai canada', 'ai for municipalities canada', 'foip ai alberta', 'canadian public sector ai', 'bilingual ai canada'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    askPlaceholder: 'Ask about a policy or a bylaw…',
    card: 'Canadian storage, Canadian inference, procurement-ready answers and a self-host path.',
    prompts: ['Summarise this council report for a public audience', 'Where is our data stored, in one paragraph I can quote?'],
    sections: [
      {
        heading: 'The four questions procurement always asks',
        bullets: [
          'Where is the data stored? — In Canada, in the Canada Central region (Montréal): accounts, conversations, memory and uploaded files.',
          'Where is it processed? — The models that write answers are served on Canadian-located GPU hardware.',
          'Can we delete it? — Conversations, memory facts, files and whole accounts can be deleted; share links are revocable.',
          'Who else sees it? — Only the people invited to a project. Nothing is shared unless a link is created, and nothing is used to train AI models.',
        ],
        paragraphs: ['Those four answers are the same whether the buyer is a city of forty thousand or a federal agency, and they are on this page in language you can paste into a briefing note.'],
      },
      {
        heading: 'What it does for a public body',
        bullets: [
          'Policy and bylaw Q&A — the procedural bylaw, the records-retention schedule, the procurement policy, the council handbook, each answered with the passage.',
          'Plain-language rewriting — a staff report or technical memo turned into something a resident can read, without changing what it says.',
          'Meeting and agenda support — draft summaries, talking points and public-facing explainers from documents the office already produces.',
          'Bilingual service — a document in English and a first draft in French (or the reverse) for staff to refine, never as a substitute for translation review.',
          'Onboarding — a new employee asks the questions a senior colleague would otherwise answer for a month.',
        ],
      },
      {
        heading: 'Access-to-information and FOIP awareness',
        paragraphs: [
          'Public bodies hold records that may be subject to access-to-information legislation, and to privacy statutes such as British Columbia’s FIPPA, Alberta’s FOIP, Ontario’s MFIPPA and Quebec’s Law 25. Those laws govern collection, use, disclosure and retention.',
          'Digby stores data in Canada and gives you the deletion and access controls those regimes care about, but it does not make a public body compliant and we do not claim that it does. A records officer still decides what may be recorded, how long it is kept and what may be disclosed.',
          'The practical implication for a records manager: treat a Digby project like any other shared drive holding working material, and apply your existing retention schedule to it rather than inventing a new one.',
        ],
        links: [{ href: '/compliance', label: 'Compliance in plain language' }],
      },
      {
        heading: 'Where the data and the models actually sit',
        tone: 'inverse',
        paragraphs: ['Storage is Canadian (Montréal) and inference runs on Canadian-located GPU hardware operated in Canada. Two honest exceptions: a web search sends the query to a search service, and a connected app such as Gmail or Slack talks to that app on your behalf. Nothing else leaves the country, and your content is never used to train AI models.'],
        links: [
          { href: '/infrastructure', label: 'The infrastructure story' },
          { href: '/learn/canadian-data-residency-ai', label: 'Data residency explained' },
        ],
      },
      {
        heading: 'When the rule is “our own data centre”',
        paragraphs: [
          'Agencies with a hard on-premises requirement can self-host: the full Digby stack on your own servers, pointed at your own model endpoints. Documents and inference stay inside the environment your IT team operates, and the product is the same one described on this page.',
          'That is often the cleanest answer for a public body whose security review cannot approve a hosted service, and the most honest one for a body that simply prefers to own the whole stack.',
        ],
        links: [{ href: '/self-hosted-ai', label: 'Self-hosted Digby' }],
      },
      {
        heading: 'A sensible first month',
        bullets: [
          'Start on public documents — bylaws, policies and published plans, where nobody has to make a judgment call about sensitivity.',
          'Pick one workflow — a weekly plain-language summary of a council agenda is a good first test.',
          'Confirm your own rules first — ask the records or privacy officer what may go in, before staff start uploading.',
          'Name a reviewer — anything that leaves the building gets read by a person who signs off on it.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }, { href: '/ai-public-sector-ottawa', label: 'AI for public bodies in Ottawa' }, { href: '/ai-public-sector-quebec-city', label: 'AI for public bodies in Québec City' }],
      },
    ],
    faqs: [
      { q: 'Is Digby certified for government procurement?', a: 'No. We hold no certification and do not describe Digby as compliant with any statute. What we can give you is concrete: where data is stored, where inference runs, how deletion works and where each answer came from.' },
      { q: 'Can we keep everything on-premises?', a: 'Yes. Self-hosted Digby runs the full stack on your own servers with your own model endpoints, so documents and inference stay inside your environment.' },
      { q: 'Does it work in French?', a: 'Yes. Ask in French and the answer comes back in French. Drafts still need human translation review before publication, as any machine-assisted text would.' },
      { q: 'What about access-to-information requests?', a: 'Your obligations under access legislation are unchanged. A Digby project is working material like any shared drive — apply your existing retention and disclosure rules to it, and ask your records officer before uploading anything sensitive.' },
      { q: 'Where exactly is the data stored?', a: 'In the AWS Canada Central region in Montréal, and the models that write answers are served on Canadian-located GPU hardware operated in Canada.' },
      { q: 'Can staff share an answer publicly?', a: 'Only deliberately. Nothing is visible outside a project unless someone creates a share link, and every link can be revoked.' },
    ],
    related: ['industries', 'compliance', 'private-ai', 'ai-for-business'],
  },
  {
    slug: 'industries-manufacturing',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Manufacturing',
    title: 'AI for Canadian manufacturers and plant teams',
    description: 'AI for Canadian manufacturers: safety procedures, maintenance logs and quality standards as a searchable knowledge base, with data stored in Canada.',
    eyebrow: 'Industries · Manufacturing',
    h1: 'AI for Canadian manufacturers',
    lede: 'The lockout procedure is in one binder, the maintenance history in another, the customer’s standard in a third. Put all three in one project and ask a question on the floor.',
    keywords: ['ai for manufacturing canada', 'manufacturing ai canada', 'iso 9001 ai canada', 'ai for plant maintenance canada', 'industrial ai canada', 'bilingual shop floor ai'],
    secondary: { href: '/private-ai', label: 'Private AI' },
    askPlaceholder: 'Ask about a procedure or a standard…',
    card: 'Safety procedures, maintenance history and quality standards as a knowledge base — data in Canada.',
    prompts: ['What is the lockout sequence for the press line?', 'Draft a corrective-action note for a nonconformance'],
    sections: [
      {
        heading: 'What it does on a plant floor',
        bullets: [
          'Procedure Q&A — lockout/tagout sequences, startup and shutdown checklists, changeover steps, answered with the section they came from.',
          'Maintenance history — paste in work orders and fault logs, then ask what failed before and what fixed it.',
          'Quality standards — the customer’s specification, the drawing notes, the inspection criteria, all searchable in plain language.',
          'Corrective actions — a first draft of a nonconformance note or an 8D summary from the facts a supervisor types in.',
          'Shift handover — a short written summary of what happened, what is open and what the next shift should watch.',
        ],
        links: [{ href: '/digby-vs-discreetly-ai', label: 'Digby vs an on-premises-only vendor' }],
      
      },
      {
        heading: 'Scanned paper is the normal case',
        paragraphs: [
          'Most plant documentation is paper that was scanned once, fifteen years ago, and never made searchable. Digby reads PDFs, Word documents, spreadsheets and images directly, and a scanned page is read from the page image rather than failing on an empty text layer.',
          'That means the twenty-year-old binder and the photo of the laminated procedure card on the wall are both usable inputs — you do not need a digitisation project first, and you can tell staff to photograph the sheet rather than retype it.',
        ],
      },
      {
        heading: 'Standards your QMS already follows',
        tone: 'inverse',
        paragraphs: ['If you are ISO 9001 certified, or working to IATF 16949, AS9100 or a customer-specific standard, Digby is a way to make those documents usable on the floor — not a part of your quality management system. Digby itself holds no ISO or IATF certification, and nothing here changes your certification scope or your audit obligations.'],
        links: [{ href: '/compliance', label: 'What Digby does and does not claim' }],
      },
      {
        heading: 'A bilingual floor',
        paragraphs: [
          'Ask in English, get English; ask in French, get French. For plants in Quebec or with bilingual crews, one knowledge base serves both: the procedure is uploaded once and the same question works in either language.',
          'Written procedures can be drafted in one language and reviewed in the other, which is often how a bilingual safety document actually gets produced.',
        ],
      },
      {
        heading: 'Data, and where it sits',
        paragraphs: [
          'Conversations, uploaded files and memory are stored in Canada (Montréal, Canada Central) and processed by models on Canadian-located GPU hardware. Your documents are never used to train or fine-tune AI models — a supplier drawing or a customer specification does not become somebody else’s training data.',
          'If a customer contract requires that drawings never leave your network, self-hosted Digby runs the whole stack on your own server with your own model endpoints.',
        ],
        links: [
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
          { href: '/infrastructure', label: 'Where the models run' },
        ],
      },
      {
        heading: 'A sensible first month',
        bullets: [
          'One line, one binder — digitise nothing, just upload the procedures for the line that asks the most questions.',
          'One shift of questions — let supervisors use it for a week and keep the questions that were worth answering.',
          'One controlled document rule — the project answers from the version you uploaded, so name files with their revision and review dates.',
          'Review before publishing — anything that becomes a controlled document goes through your existing approval process, unchanged.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }],
      },
    ],
    faqs: [
      { q: 'Is Digby ISO 9001 certified?', a: 'No. Digby holds no ISO or IATF certification. It is a tool that makes the documents your quality system already requires — procedures, work instructions, records — easier to search and draft.' },
      { q: 'Can it read scanned drawings and old PDFs?', a: 'It reads PDFs, Word documents, spreadsheets and images, including scanned pages read from the page image. Complex engineering drawings are better handled by attaching them for reference than by expecting the model to interpret dimension lines.' },
      { q: 'Will our customer specifications end up training an AI?', a: 'No. Your uploaded files and conversations are never used to train or fine-tune AI models.' },
      { q: 'Does it work in French?', a: 'Yes — ask in either language and the answer comes back in the same one, which suits bilingual plants and Quebec operations.' },
      { q: 'Can it run on our own network?', a: 'Yes. Self-hosted Digby runs on your own servers with your own model endpoints, so documents and inference stay inside your plant network.' },
      { q: 'Can it replace a supervisor’s judgement on a safety call?', a: 'No. It finds and quotes the procedure. Whether the line runs, who enters a confined space and when a job stops are decisions for your supervisors under your own safety program.' },
    ],
    related: ['industries', 'compliance', 'private-ai', 'ai-for-business'],
  },
  {
    slug: 'industries-first-nations',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'First Nations',
    title: 'AI for First Nations communities and administrations',
    description: 'Community-controlled AI for First Nations: data sovereignty, self-hosted option, band-administration use cases and data stored in Canada by default.',
    eyebrow: 'Industries · First Nations',
    h1: 'AI for First Nations communities and administrations',
    lede: 'Band administration carries a lot of paperwork and a duty to keep community information under community control. Digby is built to make the first easier without weakening the second.',
    keywords: ['ai for first nations canada', 'indigenous data sovereignty ai', 'first nations ai canada', 'community controlled ai canada', 'band administration ai'],
    secondary: { href: '/sovereign-ai', label: 'Sovereign AI' },
    askPlaceholder: 'Ask about a policy or a program…',
    card: 'Community-controlled hosting, band-administration use cases and Canadian storage by default.',
    prompts: ['Summarise this funding agreement’s reporting requirements', 'Draft a community notice about a water advisory'],
    sections: [
      {
        heading: 'Data sovereignty comes first',
        paragraphs: [
          'Many First Nations have made a clear decision that community data belongs under community control — who holds it, where it sits, who may use it and what happens to it afterwards. Any tool that touches community information should be able to answer those questions before it is adopted.',
          'Digby’s answer has two parts. Hosted, the data is stored in Canada and processed by models served on Canadian hardware, with visible and deletable memory and revocable sharing. Self-hosted, the whole stack runs on infrastructure the Nation operates, and nothing reaches digby.example.com unless it is configured to.',
        ],
      },
      {
        heading: 'OCAP® and community control',
        paragraphs: [
          'The First Nations principles of OCAP® — ownership, control, access and possession — are the standard reference for how First Nations information should be governed. OCAP® is a registered trademark of the First Nations Information Governance Centre, and the principles are theirs to define and steward; we name them here with respect and claim no relationship with, or endorsement from, the Centre.',
          'In practice, OCAP® points toward exactly the choices this page describes: the community decides whether a tool is used, where the data lives, who can reach it and how it is removed. A self-hosted deployment puts the infrastructure decision in the same hands as the data decision.',
        ],
        links: [
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
          { href: '/sovereign-ai', label: 'What sovereign AI means' },
        ],
      },
      {
        heading: 'What administration staff actually use it for',
        bullets: [
          'Policy and program Q&A — the funding agreement, the personnel policy, the housing policy, the reporting calendar: ask, get the clause.',
          'Reporting — turn program notes into the narrative section a funder expects, with a person reviewing before it is submitted.',
          'Community communication — a plain-language notice about a water advisory, a program deadline or a closure, drafted in the tone the community expects.',
          'Meeting support — agendas, minutes summaries and action lists from material staff already produce.',
          'Onboarding — a new band-office employee learns the procedures from the documents rather than from whoever has time that week.',
        ],
      },
      {
        heading: 'Two honest limits',
        tone: 'inverse',
        paragraphs: ['Digby is a general-purpose assistant, not a specialist in Indigenous law, treaty rights or community history — it will not replace the knowledge keepers, the lands office or legal counsel, and it should not be treated as an authority on any of them. And it does not decide what a community may share: that is a governance decision the community makes, and the tool should follow it.'],
      },
      {
        heading: 'Keeping community information in the community',
        paragraphs: [
          'If the requirement is that information never leaves infrastructure the Nation controls, self-hosted Digby is the path: the full stack on a server you operate, pointed at your own model endpoints. It is a real, documented deployment — the same Docker Compose stack described on the self-hosting page — not a promise for a future release.',
          'If hosted is acceptable, the controls are concrete: Canadian storage in Montréal, models on Canadian hardware, no training on your content, memory that can be read and deleted, and share links that only exist when someone creates one.',
        ],
        links: [
          { href: '/self-hosted-ai', label: 'How self-hosting works' },
          { href: '/compliance', label: 'Controls in plain language' },
        ],
      },
      {
        heading: 'A sensible first month',
        bullets: [
          'Decide the governance question first — council or administration decides what may go in, and it is written down before anyone uploads a thing.',
          'Start with public documents — policies, program guidelines and published funding agreements, where sensitivity is lowest.',
          'Pick one workflow — a reporting draft or a community notice, with a named reviewer.',
          'Revisit the hosting decision — hosted first for speed, self-hosted when the infrastructure decision catches up.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }],
      },
    ],
    faqs: [
      { q: 'Does Digby support Indigenous data sovereignty?', a: 'The controls point that way: Canadian storage by default, visible and deletable data, revocable sharing, no training on your content, and a self-hosted option where the Nation operates the infrastructure. Data governance decisions remain with the community.' },
      { q: 'Can we run it on our own infrastructure?', a: 'Yes. Self-hosted Digby runs the full stack on your servers with your own model endpoints, so documents and inference stay on infrastructure the Nation controls.' },
      { q: 'Is Digby affiliated with the First Nations Information Governance Centre?', a: 'No. OCAP® is a registered trademark of the First Nations Information Governance Centre, which defines and stewards those principles. We reference them with respect and claim no affiliation or endorsement.' },
      { q: 'Where is our data stored if we use hosted Digby?', a: 'In Canada — the Canada Central region in Montréal — with inference on Canadian-located GPU hardware. A web search sends the query to a search service, and a connected app talks to that app.' },
      { q: PRICING_FAQ_QUESTION, a: pricingAnswer() },
      { q: 'Should we put membership or treaty information into it?', a: 'That is a community governance decision, not a product default. Many administrations start with public policies and program guidelines and keep membership and rights-related records in their existing systems.' },
    ],
    related: ['industries', 'compliance', 'private-ai', 'ai-for-business'],
  },
  {
    slug: 'compliance',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Compliance',
    title: 'AI compliance in Canada — what Digby does, and does not',
    description: 'PIPEDA, Quebec Law 25, PHIPA and OSFI E-23 in plain language, plus exactly what Digby does about them — and the certification claims we do not make.',
    eyebrow: 'Trust · Canada',
    h1: 'Canadian AI compliance, in plain language',
    lede: 'Four laws come up in almost every Canadian AI conversation. Here is what each one actually asks of you, what Digby does about it, and what we will not claim.',
    keywords: ['ai compliance canada', 'pipeda ai requirements', 'quebec law 25 ai', 'phipa ai compliance', 'osfi e-23 ai', 'canadian ai data residency compliance'],
    secondary: { href: '/infrastructure', label: 'Where models run' },
    askPlaceholder: 'Ask about PIPEDA or Law 25…',
    card: 'What four Canadian laws ask, what Digby does about them, and the certifications we do not claim.',
    prompts: ['What does Law 25 require of an AI vendor?', 'Give me a vendor questionnaire for an AI tool'],
    sections: [
      {
        heading: 'The short version',
        paragraphs: [
          'Digby is designed to support the obligations Canadian organisations carry: data is stored in Canada, the models that answer run on Canadian hardware, your content is never used to train AI models, memory and conversations are visible and deletable, and sharing is opt-in and revocable.',
          'Digby holds no certification — not PIPEDA, not Law 25, not PHIPA, not SOC 2 — and we do not describe it as compliant with any of them. Compliance is a property of your organisation’s practice, not a badge a vendor can hand you. What a vendor can do is give you the facts you need to make your own assessment, which is what this page is for.',
        ],
      },
      {
        heading: 'PIPEDA — the federal private-sector law',
        paragraphs: [
          'PIPEDA applies to private-sector organisations that collect, use or disclose personal information in the course of commercial activity. It sets ten fair-information principles: accountability, identifying purposes, consent, limiting collection, limiting use and retention, accuracy, safeguards, openness, individual access and challenging compliance.',
          'For an AI tool, the practical questions are where the information goes, who can reach it, how long it is kept, whether it is used for anything else, and how a person can get it back or have it deleted.',
        ],
        bullets: [
          'Safeguards — data is stored in Canada and processed by models on Canadian hardware, over encrypted transport.',
          'Limiting use — your conversations, memory and files are used to answer you and never to train or fine-tune AI models.',
          'Retention and deletion — conversations, memory facts, files and accounts can be deleted, and share links revoked.',
          'Access — Settings shows every memory fact saved about a person, and they can edit or delete any of it.',
          'Accountability — an organisation still needs its own AI-use policy and a named owner. Digby does not write that for you.',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }],
      },
      {
        heading: 'Quebec’s Law 25',
        paragraphs: [
          'Quebec’s Act to modernise legislative provisions as regards the protection of personal information — Law 25 — is the strictest privacy regime in Canada. It added obligations around privacy by default, transparency about technology that identifies or profiles a person, explicit consent for certain uses, and, importantly for AI buyers, a requirement to assess whether a service involves personal information being communicated outside Quebec and to inform the Commission d’accès à l’information in some cases.',
          'Storage and processing in Canada, in a Canadian region, keeps a Quebec deployment on the domestic side of that assessment. It is not the whole of Law 25 — consent, retention and transparency obligations still fall on the organisation — and we do not claim that Digby makes an organisation Law 25 compliant.',
        ],
      },
      {
        heading: 'PHIPA and provincial health privacy',
        tone: 'inverse',
        paragraphs: ['Ontario’s PHIPA and the equivalent health statutes in other provinces govern personal health information held by health information custodians. Digby stores data in Canada and gives custodians the controls a privacy officer will ask about — deletion, memory access, scoped projects and revocable sharing — but it is not a medical device, does not diagnose, and does not make a custodian PHIPA compliant. Many clinics keep identified patient records in the clinical system and use Digby for policies, procedures and templates.'],
        links: [
          { href: '/industries-healthcare', label: 'AI for clinics and health teams' },
          { href: '/self-hosted-ai', label: 'Self-host for clinic-controlled infrastructure' },
        ],
      },
      {
        heading: 'OSFI E-23 and financial-sector model risk',
        paragraphs: [
          'OSFI’s Guideline E-23 (effective May 2027) asks federally regulated financial institutions to inventory their models, understand their limitations and govern their use through a documented model risk management framework. Provincially regulated credit unions answer to their own provincial regulator.',
          'Digby is not a credit-scoring or decisioning model and should not be used to make lending decisions. Where it can help is the documentation side: explaining a policy with the clause it came from, drafting a member communication, and keeping sources attached to answers so your own model inventory and assessment have evidence behind them.',
        ],
        links: [{ href: '/industries-credit-unions', label: 'AI for credit unions' }],
      },
      {
        heading: 'What Digby does — the concrete list',
        bullets: [
          'Stores accounts, conversations, memory and files in Canada — the Canada Central region in Montréal.',
          'Serves the answering models on Canadian-located GPU hardware operated in Canada.',
          'Never uses your conversations, memory or uploaded files to train or fine-tune AI models.',
          'Shows every memory fact in Settings, where it can be corrected or deleted.',
          'Deletes conversations individually or wholesale, and deletes accounts on request.',
          'Keeps sharing opt-in: nothing is visible to anyone unless a share link is created, and every link can be revoked.',
          'Scopes projects with viewer, editor and admin roles, so people only see what they were invited to.',
          'Runs connected apps as the person who connected them, with access limited to what that person already has.',
          'Can be self-hosted, so data and inference stay on infrastructure you operate.',
        ],
      },
      {
        heading: 'What Digby does not claim',
        bullets: [
          'No PIPEDA, Law 25, PHIPA, HIPAA or SOC 2 certification — none is held, and none is implied.',
          'No audit report or independent attestation to hand to a procurement team.',
          'No ISO 27001, ISO 9001 or IATF certification for the platform.',
          'No claim that using Digby makes an organisation compliant with anything.',
          'No claim that the AI’s output is legal, medical or financial advice.',
        ],
        paragraphs: ['We would rather answer a procurement questionnaire honestly than score well on one dishonestly. If your process needs a certification we do not have, that is a real finding and you should weigh it.'],
        links: [{ href: '/faq', label: 'The plain-language FAQ' }, { href: '/digby-vs-cohere-north', label: 'How Digby compares with Cohere North' }, { href: '/digby-vs-discreetly-ai', label: 'How Digby compares with Discreetly AI' }, { href: '/learn/choosing-a-private-ai-chatbot', label: 'Judging a private AI chatbot yourself' }],
      
      },
      {
        heading: 'The vendor questions worth asking anyone',
        bullets: [
          'Where is our data stored at rest — country, and region?',
          'Where are prompts actually processed — is inference in the same country as storage?',
          'Is our content used to train or fine-tune models, and can that change without notice?',
          'Can we see everything the assistant remembers about a user, edit it and delete it?',
          'What exactly happens when we delete a file, a conversation or an account — and how fast?',
          'Who inside the vendor can read our data, and under what circumstances?',
          'Which subprocessors are involved, and which of them operate outside the country?',
          'What happens to our data if we leave — can we export it, and is it destroyed afterwards?',
          'Do you hold any certification or independent audit report we can read?',
          'Can we run the whole thing ourselves if we decide to?',
        ],
        links: [{ href: '/digby-vs-augure-ai', label: 'How Digby answers these next to another Canadian option' }],
      },
      {
        heading: 'Not legal advice',
        paragraphs: ['This page describes how Digby is built. It is not legal advice, and it is not a compliance opinion for your organisation. PIPEDA, Law 25, PHIPA, FOIP and OSFI E-23 obligations depend on what you do, who you serve and where — talk to your own counsel or privacy officer before you rely on any of it.'],
      },
    ],
    faqs: [
      { q: 'Is there an AI that names PIPEDA and Law 25 and also publishes throughput numbers?', a: 'Not that we can find — and the honest answer includes us. Discreetly names PIPEDA and Law 25 but publishes no performance figure. Micrologic publishes cost figures but names no framework. Augure publishes CAD pricing but sells time saved, not throughput. Digby names the frameworks (this page) and states its hardware: data-centre NVIDIA GPU servers of the B300 class for production inference, plus NVIDIA DGX Spark nodes for development and tuning in a lab in Victoria, British Columbia — all located in Canada. What we do NOT publish is a throughput benchmark on this site, so we are not going to claim that row either. If a number matters to your evaluation, ask us and you will get the real measurement, including its conditions.' },
      { q: 'Is Digby PIPEDA or Law 25 compliant?', a: 'We do not claim compliance or certification under either — PIPEDA and Law 25 compliance are properties of an organisation’s own practices, not a badge a vendor holds. Digby is designed to support your obligations: Canadian storage, Canadian inference, no training on your content, visible and deletable memory, and revocable sharing. Storage and processing inside Canada keep a Quebec deployment on the domestic side of the transfer assessment, but consent, retention and transparency obligations still belong to your organisation.' },
      { q: 'Where is our data stored and where is it processed?', a: 'Stored in the Canada Central region (Montréal) and processed by models served on Canadian-located GPU hardware operated in Canada. A web search sends the query to a search service, and a connected app such as Gmail talks to that app.' },
      { q: 'Do you train on our content?', a: 'No. Your conversations, memory and uploaded files are never used to train or fine-tune AI models.' },
      { q: 'Can we delete data?', a: 'Yes — individual conversations, memory facts, uploaded files, or a whole account. Share links can be revoked at any time.' },
      { q: 'Do you have an audit report or SOC 2?', a: 'No. We hold no SOC 2 report, no independent attestation and no certification of any kind. This page is the honest version of what we can tell you.' },
      { q: 'Can we self-host to reduce vendor dependence?', a: 'Yes. Self-hosted Digby runs the full stack on your own servers with your own model endpoints, so data and inference stay on infrastructure you operate.' },
      { q: 'Who can see our data inside Digby?', a: 'Only the people invited to the project, plus the operator of the instance. Connected apps act as the person who connected them and reach only what that person can reach.' },
    ],
    related: ['industries', 'infrastructure', 'private-ai', 'self-hosted-ai'],
  },
  {
    slug: 'infrastructure',
    group: 'canada',
    updated: '2026-10-28',
    nav: 'Infrastructure',
    title: 'Canadian AI infrastructure — where the models run',
    description: 'Digby’s models run on Canadian-located GPU hardware operated in Canada. Why inference location matters as much as storage residency, and how self-hosting works.',
    eyebrow: 'Trust · Infrastructure',
    h1: 'Where Digby’s models actually run',
    lede: 'Storing data in Canada is half the answer. The other half is where the model that reads it is running — and for Digby, that is Canadian-located GPU hardware.',
    keywords: ['canadian ai infrastructure', 'ai inference canada', 'nvidia gpu canada ai', 'sovereign ai infrastructure canada', 'dgx spark canada', 'b300 gpu canada', 'canadian ai data centre'],
    secondary: { href: '/sovereign-ai', label: 'Sovereign AI' },
    askPlaceholder: 'Ask where inference happens…',
    card: 'Canadian-located GPU hardware, why inference location matters, and the self-host path.',
    prompts: ['Why does inference location matter?', 'What hardware do I need to self-host?'],
    sections: [
      {
        heading: 'Storage residency is only half the story',
        paragraphs: [
          'Most “Canadian data residency” claims cover storage only: your data sits in a Canadian data centre, and then the prompt is shipped to a model running somewhere else to be answered. The bytes were at home; the thinking happened abroad.',
          'For a privacy assessment that distinction matters. What a model reads, it processes; what it processes, another jurisdiction may be able to compel. A residency claim that stops at the disk does not answer the question a privacy officer is actually asking.',
          'Digby answers both halves: your account, conversations, memory and uploaded files are stored in Canada, and the models that write the answers are served on Canadian-located GPU hardware operated in Canada.',
        ],
        links: [{ href: '/learn/canadian-data-residency-ai', label: 'Data residency, explained properly' }],
      },
      {
        heading: 'The hardware, honestly described',
        paragraphs: [
          'Digby’s inference runs on NVIDIA GPU hardware in Canada — a data-centre-grade GPU server of the B300 class for production serving, plus NVIDIA DGX Spark nodes used for development and tuning work in a lab in Victoria, British Columbia.',
          'Those are real machines, not a cloud-region checkbox: they are operated in Canada, and the models serving chat traffic are the same family of custom-tuned open-weight models described elsewhere on this site.',
          'We deliberately do not publish facility addresses, network details, customer names or security architecture here. “Canadian-located GPU hardware operated in Canada” is the claim; a visitor does not need a floor plan to evaluate it, and publishing one would be a bad trade for everyone.',
        ],
      },
      {
        heading: 'Why this changes what you can promise',
        tone: 'inverse',
        paragraphs: ['When storage and inference are both in Canada, an organisation can say something concrete to its clients, its regulator and its board: the information stays in the country, and so does the processing. Digby’s models being open-weight is what makes that possible — a closed foreign API could not be moved onto Canadian hardware, however the contract was worded.'],
        links: [{ href: '/open-source-ai', label: 'Why open-weight models' }],
      },
      {
        heading: 'The three things that still leave Canada',
        paragraphs: [
          'We would rather list the exceptions than be caught by them. When Digby searches the live web, the search query goes to a search service and pages are fetched from the public web. When you connect an app — Gmail, Google Drive, Slack, Asana, Xero, GitHub, Discord, Telegram, iMessage — Digby talks to that app on your behalf, so that data goes to (and comes from) that service. And the marketing site’s analytics and advertising tags send usage data to Google and Meta.',
          'None of those is the chat itself: conversations, files and memory stay in Canada, and none of it is used to train AI models.',
        ],
        links: [{ href: '/learn/where-your-data-goes', label: 'Where your data goes, step by step' }],
      },
      {
        heading: 'Run it on your own GPUs',
        paragraphs: [
          'If inference should happen on hardware you own, self-hosted Digby runs the full stack — database, interface, integrations and coding workspace — on your servers, pointed at any OpenAI-compatible model endpoint: vLLM on your own GPUs, Ollama, LM Studio, or a managed GPU service you already operate.',
          'That is the same product, not a cut-down edition: projects, knowledge base, scheduled work and the coding agent all run locally, and nothing reaches digby.example.com unless you configure it to.',
        ],
        code: 'cp selfhost.env.example .env\ndocker compose -f docker-compose.selfhost.yml up -d --build',
        links: [{ href: '/self-hosted-ai', label: 'Self-hosted Digby' }],
      },
      {
        heading: 'Your own sovereignty checklist',
        bullets: [
          'Storage — in which country, and which region, is the database and file storage?',
          'Inference — where does the prompt go to be answered, and can you name the operator?',
          'Models — open-weight and replaceable, or a closed model you cannot move?',
          'Training — is your content used to train or fine-tune anything?',
          'Deletion — what happens to a file, a conversation and an account, and how fast?',
          'Exit — could you run the system yourself next quarter if you had to?',
        ],
        links: [{ href: '/learn/what-is-sovereign-ai', label: 'What sovereign AI means' }],
      },
    ],
    faqs: [
      { q: 'Do Digby’s models run in Canada?', a: 'Yes. Digby’s models are served on Canadian-located NVIDIA GPU hardware operated in Canada, not on foreign API endpoints.' },
      { q: 'Why does inference location matter?', a: 'Storage residency only covers where data sits. A model that reads your prompt processes it wherever that model runs, so the jurisdiction of processing matters as much as the jurisdiction of the disk.' },
      { q: 'What hardware does Digby run on?', a: 'Data-centre NVIDIA GPU servers of the B300 class for production serving, and NVIDIA DGX Spark nodes for development and tuning work in Canada.' },
      { q: 'Does anything leave Canada?', a: 'Three things, and we name them: a web search sends the query to a search service, a connected app (Gmail, Slack and so on) talks to that app, and the marketing site’s analytics and ad tags go to Google and Meta. Conversations, files and memory stay in Canada.' },
      { q: 'Can we run the models on our own GPUs?', a: 'Yes. Self-hosted Digby points at any OpenAI-compatible endpoint — vLLM on your own GPUs, Ollama or LM Studio — so inference happens on hardware you operate.' },
      { q: 'Is the infrastructure certified?', a: 'No. We hold no SOC 2, ISO 27001 or similar certification, and we do not claim one. This page describes where things run, not an audit result.' },
    ],
    related: ['sovereign-ai', 'compliance', 'self-hosted-ai', 'private-ai'],
  },
  {
    slug: 'deep-research',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Deep research',
    title: 'AI deep research — a council of models, one report',
    description: 'Digby’s deep research sends a council of AI models to research your question in parallel on the live web, then writes one sourced, cross-checked report.',
    eyebrow: 'Deep research',
    h1: 'Deep research by a council of AI models',
    lede: 'Some questions deserve more than a quick answer. Several models research in parallel — searching, reading and reasoning on their own — and Digby writes one sourced report.',
    keywords: ['ai deep research', 'ai research assistant', 'deep research ai canada', 'ai literature review', 'ai market research'],
    cta: 'Start a research question',
    secondary: { href: '/open-source-ai', label: 'Open models' },
    shot: 'sources',
    askPlaceholder: 'What should Digby research?',
    card: 'A council of models researches your question in parallel, then Digby writes one sourced report.',
    prompts: ['Compare heat-pump rebates across provinces', 'Research three project tools for a 10-person team'],
    sections: [
      {
        heading: 'How it works',
        bullets: [
          'Plan — Digby plans the research and briefs a council of independent models.',
          'Search — each model searches the live web, reads sources and builds its own findings.',
          'Compare — the council compares notes; disagreements are surfaced, not hidden.',
          'Report — one report, with the sources it relied on.',
        ],
      },
      {
        heading: 'Why a council beats one model',
        paragraphs: [
          'A single model researching alone tends to stop at the first plausible answer. Independent researchers searching separately find different sources, and when they disagree that disagreement is useful information — it tells you where the evidence is thin.',
          'Digby’s report keeps the sources it relied on, so you can open them and check the claims that matter to you.',
        ],
      },
      {
        heading: 'Dig deeper, any time',
        tone: 'inverse',
        paragraphs: ['Ask for research directly, or tap “Dig deeper” under any answer: first an independent check, then a full research pass. Results arrive as a new message — close the tab and come back.'],
      },
      {
        heading: 'Great for',
        chips: ['Market & competitor research', 'Buying decisions', 'Policy & regulation', 'Literature reviews', 'Technical deep dives', 'Due diligence', 'Fact-checking'],
      },
      {
        heading: 'Good research questions',
        bullets: [
          'Be specific — “heat-pump rebates for a detached home in Ontario, 2026” beats “heat pumps”.',
          'Say what the report is for — a decision, a briefing, a comparison.',
          'Name the sources you trust — government sites, standards bodies, peer-reviewed work.',
          'Ask for the disagreements — where the evidence is mixed is often the most useful part.',
        ],
      },
    ],
    faqs: [
      { q: 'Does deep research have a usage limit?', a: 'Guests and signed-in users get a daily allowance.' },
      { q: 'How long does it take?', a: 'Usually a few minutes. The report posts in the conversation when it’s ready.' },
      { q: 'Can I see the sources?', a: 'Yes. The report lists the sources it used, and every answer’s “How Digby answered” panel shows the work behind it.' },
    ],
    related: ['features', 'open-source-ai', 'learn/how-digby-double-checks-answers', 'ai-coding-agent'],
  },
  {
    slug: 'ai-coding-agent',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Digby Code',
    title: 'Digby Code — an AI coding agent that opens pull requests',
    description: 'Digby Code is an AI coding agent in a real workspace: it reads your GitHub repository, writes and runs code, verifies its changes and opens pull requests.',
    eyebrow: 'Digby Code',
    h1: 'An AI coding agent that ships',
    lede: 'Describe what to build or fix. Digby Code works in its own workspace with your repository — reading code, making changes, running your checks and opening a pull request.',
    keywords: ['ai coding agent', 'ai software engineer', 'ai pull requests', 'ai developer canada', 'autonomous coding agent'],
    cta: 'Start a coding task',
    secondary: { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
    shot: 'coding',
    askPlaceholder: 'Describe what to build or fix…',
    card: 'An AI coding agent that reads your repo, runs your checks and opens pull requests.',
    prompts: ['Add dark mode to my Next.js app', 'Fix the failing tests in my repo'],
    sections: [
      {
        heading: 'A real workspace, not a snippet',
        bullets: [
          'Import — a GitHub repository, or start from scratch.',
          'Work — Digby plans, edits files, runs commands and installs dependencies.',
          'Verify — your own typecheck, lint and test commands, before it calls the work done.',
          'Ship — it pushes a branch and opens a pull request for your review.',
        ],
      },
      {
        heading: 'You can see the plan',
        paragraphs: ['Every task starts with a short plan that updates as steps finish, and every command, file change and check is shown as it happens. Steer it mid-run by sending a message; stop it any time.'],
      },
      {
        heading: 'Long-running work, handled',
        tone: 'inverse',
        paragraphs: ['Hand off a task from any chat and a coding session starts in the background. Files, PRs and results come back to the conversation that asked. Sessions can run on a schedule and pick up where they left off.'],
      },
      {
        heading: 'Your models, your rules',
        paragraphs: ['Coding sessions run on open-weight models, and self-hosted Digby can point them at your own model servers.'],
        links: [{ href: '/self-hosted-ai', label: 'Self-hosted Digby' }],
      },
    ],
    faqs: [
      { q: 'Does Digby Code need GitHub?', a: 'No. It can start a project from scratch in its own workspace; connect GitHub when you want it to work on a repository and open pull requests.' },
      { q: 'Will it merge code by itself?', a: 'It opens a pull request for you to review. You stay in charge of what gets merged.' },
    ],
    related: ['integrations', 'open-source-ai', 'self-hosted-ai', 'features'],
  },
  {
    slug: 'integrations',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Integrations',
    title: 'Digby integrations — Gmail, Drive, Slack, GitHub and more',
    description: 'Connect Digby to Gmail, Google Calendar and Drive, Slack, GitHub, Asana, Xero, Discord, Telegram, iMessage and your own MCP servers — always with your access.',
    eyebrow: 'Integrations',
    h1: 'Digby, connected to the tools you already use',
    lede: 'Read your inbox, check your calendar, file things in Drive, post to Slack — from one conversation, always as you and only with the access you grant.',
    keywords: ['ai assistant integrations', 'ai gmail assistant', 'ai calendar assistant', 'ai slack assistant', 'mcp servers'],
    secondary: { href: '/features', label: 'See features' },
    shot: 'integrations',
    askPlaceholder: 'Ask what Digby can connect to…',
    card: 'Gmail, Calendar, Drive, Slack, GitHub, Asana, Xero, Discord, Telegram, iMessage and MCP.',
    prompts: ['Summarise my unread email from today', 'Send me a briefing every morning at 8'],
    sections: [
      {
        heading: 'Connected apps',
        chips: ['Gmail', 'Google Calendar', 'Google Drive', 'Slack', 'GitHub', 'Asana', 'Xero', 'Discord'],
        bullets: [
          'Google — triage email, draft replies, prepare meetings, find files.',
          'Slack — search channels and summarise conversations.',
          'GitHub — browse repositories, issues and pull requests; Digby Code opens PRs.',
          'Asana and Xero — find and update tasks, ask questions about your accounting data.',
        ],
      },
      {
        heading: 'Always as you, always with permission',
        paragraphs: ['Each connection uses your own sign-in, so Digby can only reach what you can already reach. Sending an email or making a change on your behalf asks for confirmation first, and you can disconnect any app from Settings.'],
      },
      {
        heading: 'Message Digby anywhere',
        bullets: [
          'Telegram — chat with Digby from any Telegram client, and hear when long tasks finish.',
          'iMessage — through the Digby Mac app.',
        ],
        links: [{ href: '/download', label: 'Download Digby' }],
      },
      {
        heading: 'Runs while you’re away',
        tone: 'inverse',
        paragraphs: ['Schedule recurring tasks and daily briefings. Digby does the work and leaves the results in your chat.'],
      },
      {
        heading: 'Bring your own tools',
        paragraphs: ['Add any remote Model Context Protocol (MCP) server and its tools become available to Digby in your chats.'],
      },
    ],
    related: ['ai-for-business', 'compliance', 'industries', 'sovereign-ai'],
  },
  {
    slug: 'self-hosted-ai',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Self-hosted',
    title: 'Self-hosted AI assistant — run Digby on your own servers',
    description: 'Run the full Digby stack on your own servers with Docker Compose and your own open-weight models — the most sovereign way to use AI in Canada.',
    eyebrow: 'Self-hosted',
    h1: 'Run Digby on your own servers',
    lede: 'The full Digby stack on your infrastructure, with your own open-weight models — the most sovereign way to use AI in Canada.',
    keywords: ['self hosted ai canada', 'on premise ai assistant', 'self hosted chatgpt alternative', 'private llm canada', 'sovereign ai infrastructure'],
    cta: 'Ask about self-hosting',
    secondary: { href: '/sovereign-ai', label: 'Sovereign AI' },
    askPlaceholder: 'Ask about self-hosting…',
    card: 'The full Digby stack on your own server, with your own open-weight models.',
    prompts: ['What hardware do I need to self-host?', 'Can I use Ollama models?'],
    sections: [
      {
        heading: 'What you run',
        bullets: [
          'The full stack — database, interface, integrations and the coding workspace.',
          'Your models — any OpenAI-compatible endpoint: vLLM, Ollama, LM Studio and more.',
          'Your rules — data, models and infrastructure under your control; nothing talks to digby.example.com unless you configure it to.',
        ],
        links: [{ href: '/digby-vs-discreetly-ai', label: 'Digby vs an on-premises-only vendor' }, { href: '/industries-manufacturing', label: 'Self-hosting on a plant floor' }, { href: '/industries-first-nations', label: 'Community-controlled hosting' }],
      
      },
      {
        heading: 'Up with Docker Compose',
        tone: 'inverse',
        paragraphs: ['Digby ships as a Docker Compose stack. Copy the env template, add a model key, start it — then Account → Admin → Setup lists what is configured and how to add the rest.'],
        code: 'cp selfhost.env.example .env\ndocker compose -f docker-compose.selfhost.yml up -d --build',
      },
      {
        heading: 'Who it is for',
        paragraphs: ['Public sector, health, legal, finance and research organisations that must keep data and inference on infrastructure they control. Interested in a self-hosted or dedicated deployment? Email us.'],
        links: [{ href: `mailto:${CONTACT_EMAIL}`, label: `Email ${CONTACT_EMAIL}` }],
      },
    ],
    related: ['sovereign-ai', 'open-source-ai', 'compliance', 'digby-vs-discreetly-ai'],
  },
  {
    slug: 'digby-kids',
    group: 'product',
    updated: '2026-10-16',
    nav: 'Digby Kids',
    title: 'Digby Kids — a safe AI tutor that helps kids think',
    description: 'Digby Kids is a Socratic AI tutor for children: parent-created accounts, strict guardrails, no ads or tracking, and hints instead of ready-made answers.',
    eyebrow: 'Digby Kids',
    h1: 'An AI tutor that helps kids think',
    lede: 'A separate, safe experience for children. Instead of handing over answers, it asks questions back and guides kids to work things out — the way a good tutor does.',
    keywords: ['ai tutor for kids', 'safe ai for kids', 'ai homework helper canada', 'kids ai chatbot', 'socratic ai tutor'],
    cta: 'Set up a kid account',
    secondary: { href: '/private-ai', label: 'Privacy for families' },
    askPlaceholder: 'Ask about Digby Kids…',
    card: 'A Socratic tutor for children, with parent-created accounts and no tracking.',
    prompts: ['How would you help my kid with fractions?', 'How do I create a child account?'],
    sections: [
      {
        heading: 'Built for learning',
        bullets: [
          'Socratic by design — questions and hints, never just the answer.',
          'Age-aware — parents set the age, and explanations match it.',
          'Safe web search — bounded, kid-appropriate lookups only.',
        ],
      },
      {
        heading: 'What a session looks like',
        paragraphs: ['Your child asks how to add two fractions. Instead of an answer, Digby Kids asks what the bottom numbers mean, suggests drawing the pieces, and checks each step — so the next question gets easier, not just the current one.'],
      },
      {
        heading: 'Parents stay in charge',
        tone: 'inverse',
        bullets: [
          'Parents create child accounts from their own account.',
          'Guardrails, plus a parent PIN to exit.',
          'No ads, analytics or advertising tags on kids’ sessions.',
          'None of the adult features — no integrations, file system or coding.',
        ],
      },
    ],
    faqs: [
      { q: 'How do I set up Digby Kids?', a: 'Sign in to your own account, open Settings and create a child account with your child’s age. They sign in separately.' },
      { q: 'Will Digby Kids do my child’s homework?', a: 'No. It guides with questions and hints so your child does the thinking.' },
    ],
    related: ['private-ai', 'features', 'industries', 'compliance'],
  },
  {
    slug: 'download',
    group: 'product',
    updated: '2026-10-16',
    platformCta: true,
    nav: 'Download',
    title: 'Download Digby for Mac, Windows, iPhone and Android',
    description: 'Get Digby on every screen: native desktop apps for macOS and Windows, or install digby.example.com on your iPhone, iPad or Android phone in two taps.',
    eyebrow: 'Download',
    h1: 'Digby on every screen',
    lede: 'Use it in the browser, add it to your home screen, or install the desktop apps.',
    keywords: ['digby download', 'ai assistant mac app', 'ai assistant windows app', 'canadian ai app'],
    cta: 'Use Digby in the browser',
    secondary: { href: '/integrations', label: 'Integrations' },
    card: 'Web, home-screen install, and native apps for macOS and Windows.',
    prompts: ['How do I install Digby on my iPhone?', 'Can I message you from iMessage?'],
    sections: [
      {
        heading: 'Get Digby',
        bullets: [
          'iPhone & iPad — open digby.example.com in Safari, tap Share, then Add to Home Screen.',
          'Android — open digby.example.com in Chrome and tap Install app.',
          'macOS — native app, with iMessage support.',
          'Windows — native app.',
        ],
        links: [
          { href: '/Digby.dmg', label: 'Download for macOS (.dmg)' },
          { href: '/Digby-Setup.exe', label: 'Download for Windows (.exe)' },
        ],
      },
      {
        heading: 'Talk instead of type',
        tone: 'inverse',
        bullets: [
          'Voice input — tap the microphone and speak; Digby turns it into text you can edit before sending.',
          'Read aloud — have any answer read back to you.',
          'Messages — chat with Digby from Telegram, or from iMessage through the Mac app.',
        ],
        links: [{ href: '/integrations', label: 'Messaging and integrations' }],
      },
      {
        heading: 'The Mac app does more',
        paragraphs: ['The macOS app keeps Digby in its own window and adds an optional helper that lets Digby read and send iMessages and complete web tasks in a browser on your Mac — only when you ask.'],
      },
    ],
    related: ['integrations', 'features', 'digby-kids', 'about'],
  },
  {
    slug: 'ia-souveraine-canada',
    group: 'canada',
    updated: '2026-10-16',
    lang: 'fr-CA',
    alternate: { lang: 'en-CA', slug: 'sovereign-ai' },
    nav: 'IA souveraine (FR)',
    title: 'IA souveraine au Canada — Digby, l’assistant IA canadien',
    description: 'Digby, assistant IA conçu au Canada : modèles ouverts sur du matériel canadien, conversations et fichiers stockés au Canada, réponses vérifiées.',
    eyebrow: 'IA souveraine · Canada',
    h1: 'L’intelligence artificielle souveraine, pensée pour le Canada',
    lede: 'Digby est un assistant IA conçu au Canada. Vos données sont stockées au Canada, les réponses proviennent de modèles ouverts exécutés sur du matériel canadien, et les réponses importantes sont vérifiées par un second modèle.',
    keywords: ['ia souveraine canada', 'intelligence artificielle canadienne', 'ia privée canada', 'chatbot ia canadien', 'assistant ia québec'],
    cta: 'Commencer à discuter',
    secondary: { href: '/sovereign-ai', label: 'Lire en anglais' },
    askPlaceholder: 'Posez votre question à Digby…',
    card: 'Modèles ouverts sur du matériel canadien, données au Canada, réponses vérifiées.',
    prompts: ['Explique l’IA souveraine en deux phrases', 'Où sont stockées mes données ?'],
    sections: [
      {
        heading: 'Vos données restent au Canada',
        paragraphs: [
          'Votre compte, vos conversations, votre mémoire et vos fichiers sont stockés sur des serveurs situés au Canada (région Canada Centre, Montréal). Vous pouvez consulter, modifier ou supprimer ce que Digby retient à votre sujet.',
          'Lorsqu’une recherche Web est nécessaire, la requête est transmise à un service de recherche ; lorsque vous connectez une application comme Gmail, Digby communique avec elle en votre nom.',
        ],
      },
      {
        heading: 'Les trois volets de la souveraineté',
        bullets: [
          'Les données — où sont stockés vos conversations, fichiers et souvenirs, et sous quelles lois.',
          'Les modèles — ouverts et remplaçables, ou enfermés chez un seul fournisseur.',
          'L’infrastructure — pourriez-vous faire fonctionner le système vous-même ?',
        ],
      },
      {
        heading: 'Des modèles ouverts, sans dépendance',
        tone: 'inverse',
        paragraphs: ['Digby utilise des modèles ouverts personnalisés, exécutés sur du matériel situé au Canada, et choisit le plus adapté à chaque question. Les organisations qui exigent un contrôle complet peuvent héberger Digby sur leur propre infrastructure, avec leurs propres modèles.'],
        links: [{ href: '/self-hosted-ai', label: 'Digby auto-hébergé (en anglais)' }],
      },
      {
        heading: 'Des réponses vérifiées',
        paragraphs: ['Pour les questions actuelles ou contestées, Digby cherche sur le Web et cite ses sources. Pour les questions importantes, un second modèle indépendant vérifie la réponse ; « Creuser davantage » lance une vérification ou une recherche approfondie.'],
      },
      {
        heading: 'Posez vos questions en français',
        chips: ['Rédaction et révision', 'Recherche Web avec sources', 'PDF, Word et tableurs', 'Recherche approfondie', 'Digby Kids'],
      },
    ],
    faqs: [
      { q: 'Digby fonctionne-t-il en français ?', a: 'Oui. Posez votre question en français et Digby répond en français.' },
      { q: 'Où sont stockées mes données ?', a: 'Votre compte, vos conversations, votre mémoire et vos fichiers sont stockés au Canada (Montréal), et les modèles d’IA qui génèrent les réponses fonctionnent sur du matériel canadien.' },
      { q: 'Digby entraîne-t-il ses modèles avec mes conversations ?', a: 'Non. Vos conversations, votre mémoire et vos fichiers ne servent jamais à entraîner ni à ajuster des modèles d’IA.' },
      { q: PRICING_FAQ_QUESTION_FR, a: pricingAnswerFr() },
    ],
    related: ['sovereign-ai', 'private-ai', 'canadian-ai-chatbot', 'learn/what-is-sovereign-ai'],
  },
  {
    slug: 'digby-vs-chatgpt',
    group: 'compare',
    updated: '2026-10-16',
    nav: 'Digby vs ChatGPT',
    title: 'Digby vs ChatGPT — a Canadian comparison (2026)',
    description: 'Digby vs ChatGPT for Canadians: where your chats are stored and processed, which models answer, memory, training, self-hosting and price, compared side by side.',
    eyebrow: 'Compare · ChatGPT',
    h1: 'Digby vs ChatGPT',
    lede: 'Both write, research and read files. The differences are where your conversations live, which models answer, and how much of the answer you can check.',
    keywords: ['digby vs chatgpt', 'chatgpt canada data', 'chatgpt alternative canada', 'is chatgpt data stored in canada', 'canadian chatgpt'],
    secondary: { href: '/chatgpt-alternative', label: 'Why switch' },
    shot: 'sources',
    askPlaceholder: 'Ask Digby to compare…',
    card: 'Storage, processing, models, memory, self-hosting and price — side by side.',
    prompts: ['How is Digby different from ChatGPT?', 'Is my ChatGPT data stored in Canada?'],
    sections: [
      {
        heading: 'At a glance',
        table: {
          columns: ['Digby', 'ChatGPT'],
          rows: [
            { label: 'Company', cells: ['Built in Canada', 'OpenAI, United States'] },
            { label: 'Where chats are stored', cells: ['Canada (Montréal), for every user', 'Outside Canada for Free and Plus; Canada at rest for eligible Enterprise, Edu and API customers'] },
            { label: 'Where answers are generated', cells: ['Open-weight models on Canadian hardware', 'OpenAI’s infrastructure, generally outside Canada'] },
            { label: 'Models', cells: ['Custom-tuned open-weight models, chosen per question', 'OpenAI’s closed models'] },
            { label: 'Second-model check', cells: ['Built in for contested and high-stakes answers', 'Not a built-in feature'] },
            { label: 'Used to train models', cells: ['Never', 'Free and Plus chats, unless you opt out; business plans not by default'] },
            { label: 'Memory', cells: ['Visible, editable and deletable', 'Saved memories you can view and delete'] },
            { label: 'Web search with sources', cells: ['Yes', 'Yes'] },
            { label: 'Self-hosting', cells: ['Available for organisations', 'Not available for ChatGPT'] },
            { label: 'Price to start', cells: [PRICING_ROW_VALUE, 'Free tier; Plus is US$20 a month'] },
          ],
          note: 'ChatGPT details from OpenAI’s published documentation as of October 2026. Plans and policies change — check the sources below.',
        },
      },
      {
        heading: 'Where your conversations live',
        paragraphs: [
          'Every Digby conversation — guest or signed in — is stored in Canada, and the model that writes the answer runs on Canadian hardware.',
          'OpenAI added Canada as a data-residency region in late 2025, but only for eligible ChatGPT Enterprise, Edu and API customers, and it covers stored data. Free and Plus users have no Canadian option, and OpenAI’s residency documentation and press coverage indicate prompts are still generally processed outside Canada.',
        ],
        sources: [
          { href: 'https://openai.com/business-data/', label: 'OpenAI — business data and residency' },
          { href: 'https://www.computerworld.com/article/4096675/openai-expands-data-residency-for-enterprise-customers.html', label: 'Computerworld — OpenAI expands data residency (Nov 2025)' },
        ],
      },
      {
        heading: 'Training and retention',
        paragraphs: [
          'Digby never uses your conversations, memory or files to train or fine-tune AI models, on any plan.',
          'OpenAI says consumer ChatGPT conversations may be used to improve its models unless you turn off “Improve the model for everyone” in Data Controls; business plans are not used for training by default. Deleted ChatGPT chats are scheduled for permanent deletion within 30 days, with some exceptions.',
          'In May 2026, a joint investigation by the federal, Québec, British Columbia and Alberta privacy commissioners found that OpenAI’s collection of personal information to train earlier ChatGPT models was overly broad; OpenAI committed to changes.',
        ],
        sources: [
          { href: 'https://help.openai.com/en/articles/7730893-data-controls', label: 'OpenAI — data controls' },
          { href: 'https://help.openai.com/en/articles/8809935-deleting-and-archiving-chats-in-chatgpt', label: 'OpenAI — deleting chats' },
          { href: 'https://www.priv.gc.ca/en/opc-news/news-and-announcements/2026/nr-c_260506/', label: 'Office of the Privacy Commissioner of Canada (May 2026)' },
        ],
      },
      {
        heading: 'How answers are made',
        paragraphs: [
          'ChatGPT answers with OpenAI’s own models. Digby routes each question to a suitable open-weight model, searches the web when facts are current or disputed, and has a different model review contested or high-stakes answers. “Dig deeper” under any answer starts an independent check or a full research council.',
        ],
        links: [{ href: '/learn/how-digby-double-checks-answers', label: 'How Digby double-checks answers' }],
      },
      {
        heading: 'When ChatGPT may suit you better',
        tone: 'inverse',
        paragraphs: ['If you rely on OpenAI-specific features or a workplace already standardised on ChatGPT Enterprise, staying may be simpler. If you want your conversations in Canada by default, open models without lock-in and answers that are checked, try Digby on your own questions.'],
        links: [{ href: '/', label: 'Try Digby' }],
      },
    ],
    faqs: [
      { q: 'Is ChatGPT data stored in Canada?', a: 'Only for eligible ChatGPT Enterprise, Edu and API customers who choose Canadian residency, and that covers stored data. Free and Plus accounts have no Canadian storage option. Digby stores every user’s data in Canada.' },
      { q: PRICING_FAQ_QUESTION, a: pricingAnswer() },
      { q: 'Can Digby do what ChatGPT does?', a: 'For everyday work — writing, research with sources, files, images, voice and code — yes. Try your own questions and compare.' },
    ],
    related: ['chatgpt-alternative', 'digby-vs-microsoft-copilot', 'private-ai', 'learn/where-your-data-goes'],
  },
  {
    slug: 'digby-vs-microsoft-copilot',
    group: 'compare',
    updated: '2026-10-16',
    nav: 'Digby vs Copilot',
    title: 'Digby vs Microsoft Copilot — a Canadian comparison',
    description: 'Digby vs Microsoft Copilot for Canadians: data residency, in-country processing, models, training and price — the consumer app and Microsoft 365 Copilot.',
    eyebrow: 'Compare · Microsoft Copilot',
    h1: 'Digby vs Microsoft Copilot',
    lede: 'Copilot lives inside Microsoft’s apps and Microsoft 365. Digby is a standalone assistant on open models in Canada. Here is how they differ for Canadians.',
    keywords: ['digby vs copilot', 'microsoft copilot canada data residency', 'copilot alternative canada', 'microsoft 365 copilot canada', 'copilot privacy canada'],
    secondary: { href: '/ai-for-business', label: 'Digby for business' },
    shot: 'answer',
    askPlaceholder: 'Ask Digby to compare…',
    card: 'Residency, in-country processing, models and price — consumer and Microsoft 365.',
    prompts: ['Should my team use Copilot or Digby?', 'Where does Microsoft 365 Copilot process data in Canada?'],
    sections: [
      {
        heading: 'At a glance',
        table: {
          columns: ['Digby', 'Microsoft 365 Copilot', 'Copilot (consumer)'],
          rows: [
            { label: 'Company', cells: ['Built in Canada', 'Microsoft, United States', 'Microsoft, United States'] },
            { label: 'Where data is stored', cells: ['Canada, for every user', 'The tenant’s region at rest — Canada for Canadian tenants', 'Not documented as Canada'] },
            { label: 'Where answers are generated', cells: ['Canadian hardware', 'In-country processing for Canada planned for 2027', 'Not documented as Canada'] },
            { label: 'Models', cells: ['Custom-tuned open-weight models', 'Closed models (OpenAI, Anthropic)', 'Closed models'] },
            { label: 'Used to train models', cells: ['Never', 'No', 'Signed-in adults’ chats, unless they opt out'] },
            { label: 'Self-hosting', cells: ['Available for organisations', 'No', 'No'] },
            { label: 'Price', cells: [PRICING_ROW_VALUE, 'US$30 per user per month (enterprise); Copilot Business US$21', 'Free app; Microsoft 365 Premium US$19.99 a month'] },
          ],
          note: 'Microsoft details from Microsoft’s own documentation and announcements as of October 2026.',
        },
      },
      {
        heading: 'Data residency vs where answers are made',
        paragraphs: [
          'For Microsoft 365 tenants in Canada, Copilot prompts and responses are stored at rest in Canada. Where the model processes them is a separate question: Microsoft announced in-country processing for Canada and, in an April 2026 update, scheduled it for 2027 — until then, processing may happen outside Canada.',
          'Digby stores conversations in Canada and generates answers on Canadian hardware today, for every user, including guests.',
        ],
        sources: [
          { href: 'https://learn.microsoft.com/en-us/microsoft-365/enterprise/m365-dr-service-copilot-offerings', label: 'Microsoft — Copilot data residency' },
          { href: 'https://www.microsoft.com/en-us/microsoft-365/blog/2025/11/04/microsoft-offers-in-country-data-processing-to-15-countries-to-strengthen-sovereign-controls-for-microsoft-365-copilot/', label: 'Microsoft — in-country processing (updated April 2026)' },
        ],
      },
      {
        heading: 'Training, memory and retention',
        paragraphs: [
          'Digby never uses your conversations, memory or files to train AI models. Microsoft says it does not use Microsoft 365 Copilot prompts, responses or organisational data to train its foundation models. In the consumer Copilot app, conversations of signed-in adults can be used for training unless they opt out, and conversation history is kept for 18 months by default. Both remember facts across chats, and memories can be deleted.',
        ],
        sources: [
          { href: 'https://learn.microsoft.com/en-us/microsoft-365/copilot/enterprise-data-protection', label: 'Microsoft — enterprise data protection' },
          { href: 'https://support.microsoft.com/en-us/microsoft-copilot/privacy-faq-for-microsoft-copilot', label: 'Microsoft — consumer Copilot privacy FAQ' },
        ],
      },
      {
        heading: 'Where each one fits',
        bullets: [
          'Copilot — teams whose work lives in Word, Excel, Outlook and Teams and who want AI inside those apps.',
          'Digby — people and teams who want one assistant across their tools, with conversations and answers in Canada, open models and checked answers.',
          'Both — many teams use Copilot inside Office and Digby for research, writing and Canadian-resident chat.',
        ],
        links: [{ href: '/digby-vs-cohere-north', label: 'Digby vs Cohere North' }, { href: '/digby-vs-augure-ai', label: 'Digby vs Augure AI' },
          { href: '/about', label: 'Who builds Digby' }, { href: '/industries', label: 'AI by Canadian sector' }, { href: '/industries-public-sector', label: 'AI for Canadian public bodies' }, { href: '/chatgpt-alternative', label: 'Digby as a ChatGPT alternative' }],
      
      },
      {
        heading: 'Try it on your own work',
        tone: 'inverse',
        paragraphs: ['Digby works with Gmail, Google Calendar and Drive, Slack, GitHub, Asana and Xero, and you can start without an account. Bring a real question from this week and compare.'],
        links: [{ href: '/integrations', label: 'See integrations' }],
      },
    ],
    faqs: [
      { q: 'Does Microsoft Copilot keep data in Canada?', a: 'Microsoft 365 Copilot stores prompts and responses at rest in Canada for Canadian tenants. In-country processing of prompts for Canada is scheduled for 2027. The consumer Copilot app does not document a Canadian option.' },
      { q: 'Is Digby a replacement for Microsoft 365?', a: 'No — Digby is an AI assistant, not an office suite. It works alongside the tools you use and connects to Google Workspace, Slack, GitHub and more.' },
    ],
    related: ['ai-for-business', 'digby-vs-chatgpt', 'digby-vs-cohere-north', 'learn/canadian-data-residency-ai'],
  },
  {
    slug: 'digby-vs-cohere-north',
    group: 'compare',
    updated: '2026-10-16',
    nav: 'Digby vs Cohere North',
    title: 'Digby vs Cohere North — Canadian AI compared',
    description: 'Digby vs Cohere North: two Canadian AI options compared — who they are for, deployment, models, data control, getting started and price.',
    eyebrow: 'Compare · Cohere North',
    h1: 'Digby vs Cohere North',
    lede: 'Both are Canadian, and both take data control seriously. North is an enterprise platform you deploy; Digby is an assistant anyone can open today — that can also be self-hosted.',
    keywords: ['digby vs cohere', 'cohere north alternative', 'canadian enterprise ai', 'cohere north canada', 'sovereign ai canada enterprise'],
    secondary: { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
    askPlaceholder: 'Ask Digby to compare…',
    card: 'Two Canadian options — who they are for, deployment, models and getting started.',
    prompts: ['Should we pick Cohere North or Digby?', 'What does self-hosting Digby involve?'],
    sections: [
      {
        heading: 'At a glance',
        table: {
          columns: ['Digby', 'Cohere North'],
          rows: [
            { label: 'Company', cells: ['Built in Canada', 'Cohere, Toronto'] },
            { label: 'Who it is for', cells: ['Individuals, families, teams and organisations', 'Large enterprises, regulated industries and the public sector'] },
            { label: 'Getting started', cells: ['Open digby.example.com — no account needed', 'Enterprise sales and deployment'] },
            { label: 'Deployment', cells: ['Hosted in Canada, or self-hosted on your servers', 'Private: on-premises, VPC, hybrid or air-gapped'] },
            { label: 'Models', cells: ['Custom-tuned open-weight models from several labs', 'Cohere’s Command models, or the customer’s own'] },
            { label: 'Price', cells: [PRICING_ROW_VALUE, 'Contact sales'] },
          ],
          note: 'Cohere North details from Cohere’s published pages as of October 2026.',
        },
      },
      {
        heading: 'Two kinds of sovereignty',
        paragraphs: [
          'Cohere North is built to be deployed inside an organisation’s own environment — on-premises, in a private cloud, even fully air-gapped — where Cohere says the data is never accessible to Cohere. It is sold to enterprises and governments; the Government of Canada signed a partnership with Cohere in 2025.',
          'Digby gives anyone a Canadian-hosted assistant straight away: conversations stored in Canada, answers from models on Canadian hardware, and a self-hosted path for organisations that need the whole stack on their own servers.',
        ],
        sources: [
          { href: 'https://cohere.com/deployment-options', label: 'Cohere — deployment options' },
          { href: 'https://cohere.com/blog/introducing-north-2', label: 'Cohere — introducing North 2' },
          { href: 'https://www.canada.ca/en/innovation-science-economic-development/news/2025/08/canada-partners-with-cohere-to-accelerate-world-leading-artificial-intelligence.html', label: 'Government of Canada — partnership with Cohere (Aug 2025)' },
        ],
      },
      {
        heading: 'Which to choose',
        bullets: [
          'Cohere North — a large organisation ready for an enterprise deployment of agents across internal systems.',
          'Digby — a person, family or team that wants a capable Canadian assistant today, with a path to self-hosting later.',
        ],
        links: [{ href: '/digby-vs-augure-ai', label: 'Digby vs Augure AI' }, { href: '/compliance', label: 'The frameworks named, in plain language' }],
      
      },
      {
        heading: 'Start in a minute',
        tone: 'inverse',
        paragraphs: ['No procurement, no install: open digby.example.com and ask. If your organisation needs Digby on its own infrastructure, email us.'],
        links: [
          { href: '/', label: 'Try Digby' },
          { href: `mailto:${CONTACT_EMAIL}`, label: 'Ask about self-hosting' },
        ],
      },
      {
        heading: 'Questions to ask either one',
        bullets: [
          'Where is our data stored at rest, and where do prompts get processed?',
          'Which models are available, and can we bring or change our own?',
          'What does a private or self-hosted deployment involve, and who operates it?',
          'How do users see and control what the assistant remembers?',
          'What does it cost for the number of people who will actually use it?',
        ],
        links: [{ href: '/learn/ai-at-work-in-canada-checklist', label: 'The AI-at-work checklist' }],
      },
    ],
    faqs: [
      { q: 'Is Cohere Canadian?', a: 'Yes. Cohere is headquartered in Toronto. Digby is also built in Canada.' },
      { q: 'Can I try Cohere North myself?', a: 'North is sold to organisations through Cohere’s sales team. Digby can be tried at digby.example.com without an account.' },
      { q: 'Which is more private?', a: 'Both can keep data under your control: North through private deployment inside your own environment, Digby through Canadian hosting by default and self-hosting for organisations that need it. The better fit depends on who will use it and how much infrastructure you want to run.' },
    ],
    related: ['self-hosted-ai', 'sovereign-ai', 'digby-vs-microsoft-copilot', 'learn/what-is-sovereign-ai'],
  },
  {
    slug: 'digby-vs-augure-ai',
    group: 'compare',
    updated: '2026-10-28',
    nav: 'Digby vs Augure AI',
    title: 'Digby vs Augure AI — two sovereign Canadian options',
    description: 'Digby vs Augure AI: two Canadian sovereign-AI options compared — their named models, deployment, data control, getting started, price and self-hosting.',
    eyebrow: 'Compare · Augure AI',
    h1: 'Digby vs Augure AI',
    lede: 'Both are genuinely Canadian: Canadian-hosted, Canadian-processed, and sold as sovereignty rather than novelty. The difference is what sits underneath.',
    keywords: ['digby vs augure', 'augure ai alternative', 'canadian sovereign ai comparison', 'sovereign canada ai models', 'augure ai canada', 'canadian ai model providers'],
    secondary: { href: '/sovereign-ai', label: 'Sovereign AI' },
    askPlaceholder: 'Ask Digby to compare…',
    card: 'Two genuinely Canadian sovereign options — models, deployment, price and self-hosting.',
    prompts: ['Should we pick Augure AI or Digby?', 'What does open-weight actually buy us?'],
    sections: [
      {
        heading: 'At a glance',
        table: {
          columns: ['Digby', 'Augure AI'],
          rows: [
            { label: 'Company', cells: ['Built in Canada', 'Toronto (The Altercation Company)'] },
            { label: 'Models', cells: ['Custom-tuned open-weight models', 'Their own named Canadian models'] },
            { label: 'Sovereignty', cells: ['Canadian storage + Canadian inference', 'Canadian storage + Canadian inference'] },
            { label: 'Getting started', cells: ['No account needed to start', 'Free tier, CAD plans from $20/mo'] },
            { label: 'Openness', cells: ['Open-weight, swappable', 'Proprietary, trained in-house'] },
            { label: 'Self-hosting', cells: ['Full stack, any compatible endpoint', 'Enterprise VPC, on-prem or GPU'] },
            { label: 'Price', cells: [PRICING_ROW_VALUE, 'Free tier, Pro $20, Max $80 CAD a month'] },
          ],
          note: 'Augure AI details from their published pages as of October 2026.',
        },
      },
      {
        heading: 'What Augure AI actually is',
        paragraphs: [
          'Augure AI — operating as The Altercation Company in Toronto — offers models it has trained itself and named for Canadian places: Rosedale One for frontier reasoning, Ossington 5 as a Canadian-tuned model for law, tax and Quebec French, and Tofino 3 for fast everyday work. Their pages state storage in Canada and inference in Canada under zero-retention agreements, never through US providers.',
          'They make their ownership explicit in a way that matters to Canadian buyers: no US corporate parent and no US investors. Pricing is published in CAD — a free tier, Pro at $20 a month and Max at $80 a month — with enterprise options for custom VPC, on-premises and GPU deployments, and a public trust centre on Vanta.',
          'That is a real sovereign Canadian product, not a rebadged foreign API. They also ship more than chat: a knowledge product, contract review for Canadian law, and a coding agent of their own. If your requirement is “a Canadian model, from a Canadian company, with Canadian inference”, they satisfy it honestly.',
        ],
        sources: [
          { href: 'https://augureai.ca/', label: 'Augure AI — models, sovereignty claims and team' },
          { href: 'https://augureai.ca/pricing', label: 'Augure AI — CAD pricing tiers' },
        ],
      },
      {
        heading: 'Where Digby differs',
        bullets: [
          'Open weights — Digby runs custom-tuned open models rather than proprietary ones, so the intelligence is inspectable and replaceable, and a better open model can be adopted when it ships.',
          'Multi-model routing plus a check — the answer comes from the model suited to the question, and contested or high-stakes answers get an independent second model reviewing the first.',
          'Deep research — a council of models researches a question in parallel and writes one sourced report.',
          'A coding agent in the same product — Digby Code works in a real workspace and opens pull requests.',
          'No-account start — open digby.example.com and type, rather than choosing a plan first.',
          'Self-host on anything — the full stack runs against any OpenAI-compatible endpoint: vLLM, Ollama or LM Studio on your own GPUs.',
        ],
        links: [
          { href: '/open-source-ai', label: 'Why open-weight models' },
          { href: '/ai-coding-agent', label: 'Digby Code' },
        ],
      },
      {
        heading: 'The honest comparison on sovereignty',
        tone: 'inverse',
        paragraphs: ['Augure AI is defensible as “sovereign” in the strict sense: Canadian company, Canadian models, Canadian storage, Canadian inference, no foreign parent. Digby is defensible differently — Canadian storage, Canadian inference on Canadian-located GPU hardware, open weights so nothing is locked to one vendor, and a documented self-hosting path. Where the emphasis is a proprietary Canadian model, they are ahead; where the emphasis is not being locked to any single model vendor, Digby is.'],
        links: [{ href: '/infrastructure', label: 'Where Digby’s models run' }],
      },
      {
        heading: 'When Augure AI suits you better',
        paragraphs: [
          'Choose them if your procurement rule is that every layer — model, company, storage, inference — must be Canadian and proprietary is preferred over open-weight; if you want a published per-seat price list to compare against a budget line; or if you want a vendor whose headline promise is a named model rather than a routing layer.',
          'Choose Digby if you want to start in ten seconds without a plan, if open weights matter to your exit strategy, if you want the research council and coding agent in the same product, or if your path ends in self-hosting on hardware you already own.',
        ],
        links: [{ href: '/industries-legal', label: 'AI for Canadian law firms' }, { href: '/digby-vs-cohere-north', label: 'Digby vs Cohere North' }],
      
      },
      {
        heading: 'Questions worth asking either of us',
        bullets: [
          'Where is the data stored, and where is the prompt processed — can you name both?',
          'Are the models open-weight, and can we swap them if a better one appears?',
          'What happens to our data if we leave?',
          'Can we run the whole system ourselves if we need to?',
          'Do you hold any certification or audit report we can read?',
        ],
        links: [{ href: '/compliance', label: 'What Digby does — and does not — claim' }],
      },
    ],
    faqs: [
      { q: 'Is Augure AI Canadian?', a: 'Yes. They present themselves as Canadian-owned with no US parent or investors, and their pages describe storage and inference in Canada. Digby is also built in Canada.' },
      { q: 'Which is more sovereign?', a: 'They answer different questions. Augure AI emphasises its own named Canadian models; Digby uses open-weight models, so the intelligence can be swapped, and publishes a self-hosting path that runs on any OpenAI-compatible endpoint. Both keep data and inference in Canada.' },
      { q: 'Can I try both?', a: 'Augure AI publishes a free tier and paid CAD plans. Digby can be tried at digby.example.com with no account at all.' },
      { q: 'Does Digby certify compliance?', a: 'No. Digby holds no PIPEDA, Law 25 or SOC 2 certification and we do not describe it as compliant. We describe exactly where data lives, where inference runs and how deletion works.' },
      { q: 'Can I self-host Digby?', a: 'Yes — the full stack on your own servers, pointed at your own model endpoints, with nothing reaching digby.example.com unless you configure it.' },
    ],
    related: ['sovereign-ai', 'self-hosted-ai', 'digby-vs-cohere-north', 'compliance'],
  },
  {
    slug: 'digby-vs-discreetly-ai',
    group: 'compare',
    updated: '2026-10-28',
    nav: 'Digby vs Discreetly AI',
    title: 'Digby vs Discreetly AI — hosted in Canada or on-prem',
    description: 'Digby vs Discreetly AI: on-premises-only deployment compared with a Canadian-hosted assistant you can start today — data location, speed to use and price.',
    eyebrow: 'Compare · Discreetly AI',
    h1: 'Digby vs Discreetly AI',
    lede: 'Discreetly AI sells a deployment project. Digby is a Canadian-hosted assistant you can use in a minute — with a self-hosted path for when you do want it inside your walls.',
    keywords: ['digby vs discreetly ai', 'discreetly ai alternative', 'on premise ai canada', 'private ai deployment canada', 'canadian ai for manufacturing', 'air gapped ai canada'],
    secondary: { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
    askPlaceholder: 'Ask Digby to compare…',
    card: 'On-prem deployment project versus a Canadian-hosted assistant with a self-host path.',
    prompts: ['Is on-prem always more private?', 'What does self-hosting Digby involve?'],
    sections: [
      {
        heading: 'At a glance',
        table: {
          columns: ['Digby', 'Discreetly AI'],
          rows: [
            { label: 'Deployment', cells: ['Canadian-hosted, or self-hosted', 'On-premises / private cloud'] },
            { label: 'Time to first use', cells: ['Minutes, no install', 'A deployment project'] },
            { label: 'Where it runs', cells: ['Canadian hardware operated in Canada', 'Your own infrastructure'] },
            { label: 'Getting started', cells: ['No account needed to start', 'Consultative, enterprise sale'] },
            { label: 'Sector focus', cells: ['Any sector; six sector pages', 'Manufacturing, health, legal, finance'] },
            { label: 'Price', cells: [PRICING_ROW_VALUE, 'Contact sales'] },
          ],
          note: 'Discreetly AI details from their published pages as of October 2026.',
        },
      },
      {
        heading: 'What Discreetly AI actually is',
        paragraphs: [
          'Discreetly AI deploys a private retrieval assistant directly into your own infrastructure — on-premises or private cloud, with air-gap capability — aimed at manufacturing, healthcare, legal and financial organisations. Their central promise is that documents, queries and answers never leave your environment and never reach a third-party model API.',
          'The site is genuinely bilingual English and French, and the framing is built around the standards their buyers already answer to: ISO 9001, ISO 45001 and IATF 16949 in manufacturing, PIPEDA and Law 25 for Canadian data, HIPAA-aligned handling for health. Every answer cites the source document and page number, they index scanned PDFs and training videos (with self-hosted transcription), and pricing is a fixed monthly infrastructure cost rather than per-token billing — quoted rather than published, through a consultative sale.',
          'For a buyer whose requirement is that nothing leaves the building, that posture is genuinely stronger than a hosted product. That is worth saying plainly.',
        ],
        sources: [
          { href: 'https://discreetlyai.com/', label: 'Discreetly AI — deployment, sourcing and pricing model' },
          { href: 'https://discreetlyai.com/industries.html', label: 'Discreetly AI — industries and standards framing' },
        ],
      },
      {
        heading: 'Where Digby differs',
        bullets: [
          'Usable today — open digby.example.com and ask, with no deployment project, no procurement cycle and no account.',
          'Canadian-hosted by default for everyone — storage in Montréal, inference on Canadian-located GPU hardware, including for guests.',
          'A self-host path you can take later — the full stack on your servers with any OpenAI-compatible endpoint, so “on-prem” is a step you can reach rather than a project you must start with.',
          'Verified answers — sources on grounded answers, an independent second model checking high-stakes replies, and a deep research council for the hardest questions.',
          'A coding agent in the same product — Digby Code works in a real workspace and opens pull requests.',
        ],
        links: [
          { href: '/ai-for-business', label: 'AI for Canadian businesses' },
          { href: '/private-ai', label: 'Private AI' },
        ],
      },
      {
        heading: 'On-prem is not automatically more private',
        tone: 'inverse',
        paragraphs: ['A server in your building that you have not patched, logged or access-controlled is not a privacy win. Discreetly AI is right that on-premises removes a class of vendor risk; it also moves the operating burden onto you. Digby’s position is that most organisations should start hosted — where the security work is done for them — and self-host when a specific obligation demands it, with the same product on both sides of that line.'],
        links: [{ href: '/infrastructure', label: 'Where the models run' }],
      },
      {
        heading: 'When Discreetly AI suits you better',
        paragraphs: [
          'Choose them if your security review requires an air-gapped or fully on-premises deployment from day one, if you need a vendor to run the deployment with you, if you want a supplier whose compliance framing names your industry standards explicitly, or if audit logs are a hard procurement requirement.',
          'Choose Digby if you want to evaluate the tool this afternoon rather than after a deployment, if Canadian hosting is acceptable and a self-host option is enough for the future, or if you want research, coding and chat in one assistant.',
        ],
      },
      {
        heading: 'Either way, ask these',
        bullets: [
          'What exactly runs in our environment, and what still calls out?',
          'Where is the data stored, and where is inference performed?',
          'Do you hold the certifications you name, or are they your customers’ certifications?',
          'What does the deployment cost in staff time, not just licence fees?',
          'What happens to our data if we leave, and how do we get it out?',
        ],
        links: [{ href: '/compliance', label: 'What Digby does — and does not — claim' }],
      },
    ],
    faqs: [
      { q: 'Is Discreetly AI Canadian?', a: 'Their pages present a bilingual Canadian business selling on-premises and private-cloud AI, with PIPEDA and PHIPA framing for Canadian buyers. Digby is also built in Canada.' },
      { q: 'Is on-premises more private than hosted?', a: 'It removes a class of vendor risk and adds an operating burden. For most organisations, hosted with Canadian storage and Canadian inference is enough; self-hosting is the right choice when a specific obligation demands it.' },
      { q: 'Can Digby run fully on-premises?', a: 'Yes. Self-hosted Digby runs the full stack — database, interface, integrations and coding workspace — on your servers with your own model endpoints.' },
      { q: 'Does Digby have audit logs?', a: 'Digby keeps grounded answers tied to the passages they came from and gives you deletion and sharing controls. It does not market itself as a compliance audit-log platform, and we do not claim a logging certification.' },
      { q: 'Can I try Digby before talking to anyone?', a: 'Yes — open digby.example.com and ask a question. No account, no sales call.' },
    ],
    related: ['self-hosted-ai', 'sovereign-ai', 'industries-manufacturing', 'digby-vs-augure-ai'],
  },
  {
    slug: 'faq',
    group: 'company',
    updated: '2026-10-16',
    nav: 'FAQ',
    title: 'Digby FAQ — privacy, models, pricing and data in Canada',
    description: 'Answers to common questions about Digby: where your data is stored, which AI models it uses, what it costs, and how it keeps its answers accurate.',
    eyebrow: 'FAQ',
    h1: 'Frequently asked questions',
    lede: 'Short answers to what people ask most. Still curious? Ask Digby.',
    keywords: ['digby faq', 'digby ai questions', 'is digby free', 'where is digby data stored'],
    faqHeading: false,
    cta: 'Ask Digby directly',
    secondary: { href: '/features', label: 'See features' },
    askPlaceholder: 'Ask your own question…',
    card: 'Privacy, models, pricing and data in Canada — short answers.',
    prompts: ['Can you answer in French?', 'What are today’s deep research limits?'],
    sections: [
      {
        heading: 'Start here',
        paragraphs: [
          'Most questions about Digby come down to one of four things: where the data lives, what it runs on, whether you can trust the answer, and what it costs. The answers above are short on purpose — each one links to the page that goes into the detail, with the caveats intact.',
          'If you are evaluating Digby for an organisation rather than yourself, read the compliance page before you read anything else. It states plainly what Digby does not claim, which is the part a procurement questionnaire will find anyway.',
        ],
        links: [
          { href: '/private-ai', label: 'Private AI for Canadians' },
          { href: '/compliance', label: 'Compliance in plain language' },
          { href: '/infrastructure', label: 'Where the models actually run' },
          { href: '/industries', label: 'AI shaped around Canadian industries' },
          { href: '/deep-research', label: 'How deep research works' },
          { href: '/download', label: 'Get the Digby apps' },
          { href: '/ia-souveraine-canada', label: 'En français : l’IA souveraine au Canada' },
        ],
      },
    ],
    faqs: [
      { q: 'What is Digby?', a: 'A Canadian-built AI assistant. It answers, writes, researches, analyses files and code, and works across your tools — on open-weight models running on Canadian hardware.' },
      { q: 'Where is my data stored?', a: 'In Canada — Montréal, Canada Central.' },
      { q: 'Does my data leave Canada?', a: 'Stored data and the models that write answers stay in Canada. A web search sends the search query to a search service, a connected app talks to that app, and the site’s analytics tags send usage data to Google and Meta.' },
      { q: 'Which AI models does Digby use?', a: 'Custom-tuned open models, picked per question, with a different model checking important answers.' },
      { q: PRICING_FAQ_QUESTION, a: pricingAnswer() },
      { q: 'How does Digby keep answers accurate?', a: 'It searches the live web when facts are time-sensitive, cites sources, and has an independent model check contested or high-stakes answers. “Dig deeper” escalates any answer further.' },
      { q: 'Does Digby train AI on my conversations?', a: 'No. Your chats, memory and files are never used to train or fine-tune AI models.' },
      { q: 'Can I delete my data?', a: 'Yes — conversations, memory facts, or your whole account.' },
      { q: 'Is Digby safe for kids?', a: 'Digby Kids is a separate, parent-created experience with strict guardrails, no ads or tracking, and a Socratic tutor.' },
      { q: 'Does Digby work in French?', a: 'Oui. Ask in French and Digby answers in French.' },
      { q: 'Can my organisation self-host Digby?', a: 'Yes, with Docker Compose and any OpenAI-compatible model server.' },
      { q: 'How is Digby different from ChatGPT?', a: 'Your data is stored in Canada for every user, answers come from open-weight models on Canadian hardware, and important answers are checked by a second model.' },
    ],
    related: ['private-ai', 'sovereign-ai', 'digby-vs-chatgpt', 'about'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Learn (long-form guides — the informational keywords)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every public landing page: the hand-written pages above plus the generated
 * city × vertical layer (30 pages, see cities.ts). One array feeds the page
 * template, the sitemap, JSON-LD, the footer and `publicPaths()`, so the
 * generated pages are first-class throughout.
 */
export const SITE_PAGES: SitePage[] = [...CORE_SITE_PAGES, ...cityPages()];

export const LEARN_ARTICLES: LearnArticle[] = [
  {
    slug: 'what-is-sovereign-ai',
    nav: 'What is sovereign AI?',
    topic: 'Sovereignty',
    title: 'What is sovereign AI? A plain-language guide for Canadians',
    description: 'Sovereign AI explained: data residency, model control and infrastructure — what it means for Canada, why it matters, and how to evaluate an AI tool.',
    h1: 'What is sovereign AI?',
    lede: 'Controlling the AI you depend on — where the data lives, which models run, and who operates the infrastructure.',
    keywords: ['what is sovereign ai', 'sovereign ai canada', 'ai sovereignty', 'canadian sovereign ai models'],
    published: '2026-10-14',
    updated: '2026-10-16',
    readMinutes: 7,
    askPlaceholder: 'Ask about this guide…',
    card: 'Data residency, model control and infrastructure — what it means for Canada and how to evaluate a tool.',
    prompts: ['Is my current AI tool sovereign?', 'Give me a 5-question sovereignty checklist'],
    sections: [
      {
        heading: 'A working definition',
        paragraphs: [
          'AI sovereignty is the ability to use AI without depending on decisions made elsewhere. For a country, that means domestic capacity and laws that apply. For an organisation, knowing where its data goes and being able to switch providers. For a person, control over what is stored and shared.',
          'It is not the same as isolation. A sovereign setup can still use the best models in the world — the question is whether you can choose them, host them where you want, and replace them if you need to.',
        ],
      },
      {
        heading: 'The three layers',
        bullets: [
          'Data sovereignty — where conversations, documents and memory are stored, and whose laws govern access.',
          'Model sovereignty — whether models are open and replaceable, or controlled by one company that can change terms, prices or availability.',
          'Infrastructure sovereignty — who operates the servers and chips, and whether you could run the system yourself.',
        ],
      },
      {
        heading: 'Why it matters for Canada',
        paragraphs: [
          'Most popular assistants are operated outside Canada. That raises practical questions: which laws apply to your data, whether you can meet your own privacy obligations, and what happens if a foreign provider changes its policies.',
          'Canadian governments have made sovereign compute a priority, and privacy regulators have begun scrutinising how large AI services collect personal information. For organisations, sovereignty is increasingly part of procurement: buyers want to know not just where data sits, but who can reach it.',
        ],
      },
      {
        heading: 'Residency is a start, not the finish',
        paragraphs: [
          'Storing data in Canada matters, but so do the model that reads your prompt and the company running the servers. Some services store your history in Canada but send each prompt to a model running in another country.',
          'Open-weight models can be hosted anywhere — including in Canada or on your own hardware — and self-hosting closes the loop.',
        ],
        links: [{ href: '/learn/canadian-data-residency-ai', label: 'Data residency and AI in Canada' }],
      },
      {
        heading: 'How to evaluate a tool',
        bullets: [
          'Storage — where is my data stored at rest, including backups?',
          'Processing — where does the model that reads my prompt run?',
          'Models — are they open-weight, and can the provider switch them without breaking my work?',
          'Operator — which company runs the infrastructure, and under which country’s laws?',
          'Exit — can I export my data and leave, or run the system myself?',
        ],
      },
      {
        heading: 'How Digby approaches it',
        tone: 'inverse',
        bullets: [
          'Accounts, conversations, memory and files stored in Canada.',
          'Open-weight models on Canadian hardware, chosen per question, no single-vendor lock-in.',
          'A self-hosted option for full control of data, models and infrastructure.',
        ],
        links: [
          { href: '/sovereign-ai', label: 'Sovereign AI with Digby' },
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
        ],
      },
    ],
    faqs: [
      { q: 'Is sovereign AI the same as Canadian AI?', a: 'Not exactly. A Canadian company can still depend on foreign infrastructure and closed models. Sovereignty is about control, wherever the vendor is based.' },
      { q: 'Can open-weight models be sovereign?', a: 'Yes. Because the weights are published, they can be hosted by a Canadian provider or on your own hardware.' },
      { q: 'Do I need to self-host to be sovereign?', a: 'No. Self-hosting gives the most control, but a provider that stores data and runs models in Canada on open models covers most of what individuals and many organisations need.' },
    ],
    related: ['sovereign-ai', 'learn/canadian-data-residency-ai', 'learn/where-your-data-goes', 'self-hosted-ai'],
  },
  {
    slug: 'where-your-data-goes',
    nav: 'Where your data goes',
    topic: 'Privacy',
    shot: 'memory',
    title: 'Where your data goes when you chat with Digby',
    description: 'A step-by-step walkthrough of what happens to a message you send Digby: where it is stored, which models read it, what leaves Canada and what you control.',
    h1: 'Where your data goes when you chat with Digby',
    lede: 'Privacy claims are easy to make. Here is what actually happens to a message, from the moment you press send to the moment you delete it.',
    keywords: ['where is my ai chat data stored', 'ai chatbot data canada', 'digby privacy', 'how ai chatbots use your data', 'ai data flow'],
    published: '2026-10-16',
    updated: '2026-10-16',
    readMinutes: 6,
    askPlaceholder: 'Ask where your data goes…',
    card: 'Step by step: what happens to a message, what stays in Canada and what you control.',
    prompts: ['Where is this conversation stored?', 'What do you remember about me?'],
    sections: [
      {
        heading: 'You press send',
        paragraphs: ['Your message travels from your browser or app to Digby over an encrypted HTTPS connection, to servers in Montréal (the Canada Central region).'],
      },
      {
        heading: 'Digby gathers the context it needs',
        paragraphs: ['To answer well, Digby adds the recent conversation, any memory facts relevant to the question, and — if you’re in a project — that project’s instructions and the passages from its documents that match. All of that is stored with your account in Canada.'],
      },
      {
        heading: 'A model writes the answer',
        paragraphs: [
          'Digby decides how much work the question needs and sends the conversation to a custom-tuned open-weight model running on hardware in Canada. The model receives what it needs to answer — never your password or account credentials.',
          'For contested or high-stakes questions, a second model reviews the answer; for research, several models work in parallel. They run on Canadian hardware too — and so do the models that search your documents and read your images.',
          'Your message is used to answer you, and that is all: Digby never uses your conversations, memory or files to train or fine-tune AI models.',
        ],
      },
      {
        heading: 'What can leave Canada — and when',
        bullets: [
          'Web search — when an answer needs current facts, the search query (a few words, not your whole conversation) goes to a search service, and the pages Digby reads are fetched from the public web.',
          'Connected apps — if you connect Gmail, Slack or another app, Digby talks to that app on your behalf, and that app’s own privacy terms apply.',
          'Site analytics — the website uses Google and Meta measurement tags for page views and sign-ups, as the privacy policy describes. Digby Kids is never tracked.',
        ],
        links: [{ href: '/privacy', label: 'Read the privacy policy' }],
      },
      {
        heading: 'The answer is saved — to your history',
        paragraphs: [
          'The conversation is saved to your account in Canada so you can come back to it. If you shared a durable fact (“I’m vegetarian”, “we’re a team of 12”), Digby may save it to your memory so it can use it next time.',
          'Guests without an account keep their history in the browser they used; the server keeps a short-lived working copy in Canada for up to 24 hours so the conversation can continue.',
        ],
      },
      {
        heading: 'You stay in control',
        tone: 'inverse',
        bullets: [
          'See it — Settings → Memory lists every fact Digby has saved about you.',
          'Change it — edit or delete any memory fact, or clear them all.',
          'Delete it — remove a single conversation, or ask for your whole account to be deleted.',
          'Share it only on purpose — a share link is read-only and can be revoked.',
        ],
        links: [{ href: '/private-ai', label: 'Private AI with Digby' }],
      },
    ],
    faqs: [
      { q: 'Does Digby send my conversation to a search engine?', a: 'No. When a search is needed, Digby sends a short search query, not your conversation.' },
      { q: 'Is my data used to train AI models?', a: 'No. Digby never uses your conversations, memory or uploaded files to train or fine-tune AI models.' },
      { q: 'Can Digby employees read my chats?', a: 'Your chats are tied to your account and are not visible to other users unless you share them. See the privacy policy for how data is handled and secured.' },
      { q: 'What about guests?', a: 'Guest history is kept in the browser that started it, with a short-lived working copy on the server in Canada for up to 24 hours. Create an account to keep conversations across devices.' },
    ],
    related: ['private-ai', 'learn/canadian-data-residency-ai', 'learn/choosing-a-private-ai-chatbot', 'digby-vs-chatgpt'],
  },
  {
    slug: 'canadian-data-residency-ai',
    nav: 'Data residency & AI',
    topic: 'Privacy',
    title: 'Data residency and AI in Canada: where does chat data go?',
    description: 'A practical guide to data residency for AI tools in Canada — what “stored in Canada” really covers, what to ask a vendor, and what the law expects.',
    h1: 'Data residency and AI in Canada',
    lede: 'When you type into an AI chatbot, your words travel somewhere. What “stored in Canada” does and doesn’t cover, and what to ask before you paste in anything sensitive.',
    keywords: ['ai data residency canada', 'canadian data residency', 'where is chatbot data stored', 'ai privacy canada'],
    published: '2026-10-14',
    updated: '2026-10-16',
    readMinutes: 7,
    askPlaceholder: 'Ask about data residency…',
    card: 'What “stored in Canada” really covers, and what to ask an AI vendor.',
    prompts: ['Where is this conversation stored?', 'What should I ask an AI vendor about residency?'],
    sections: [
      {
        heading: 'Three places your data can be',
        bullets: [
          'At rest — the stored copy of your account, chat history, uploaded files and memory.',
          'In processing — the text a model reads to generate an answer.',
          'In logs and backups — copies kept for reliability, debugging or abuse monitoring.',
        ],
      },
      {
        heading: 'What “stored in Canada” usually means',
        paragraphs: [
          'A provider that says your data is stored in Canada is normally talking about data at rest. That matters: it decides where your history physically lives. But it is worth asking separately where processing happens and where logs and backups are kept.',
          'The gap is real. Some large AI providers now offer Canadian storage on enterprise plans while the model that reads each prompt still runs in another country — and their free and consumer plans usually have no Canadian option at all.',
        ],
        links: [
          { href: '/digby-vs-chatgpt', label: 'Example: ChatGPT’s residency options' },
          { href: '/digby-vs-microsoft-copilot', label: 'Example: Microsoft Copilot’s residency options' },
        ],
      },
      {
        heading: 'Questions to ask',
        bullets: [
          'Where are conversations and files stored at rest?',
          'Which AI models process my prompts, where do they run, and who operates them?',
          'Can I see and delete what the assistant remembers about me?',
          'Is my content used to train models, and can I opt out?',
          'Can I export or delete everything and leave?',
          'Is there a self-hosted or dedicated option if we need full control?',
        ],
      },
      {
        heading: 'What the law expects',
        paragraphs: [
          'Under PIPEDA, Canada’s federal private-sector privacy law, organisations may send personal information outside Canada for processing, but they remain accountable for it: they must protect it with contracts and other means, and be open with people that it may be processed abroad.',
          'Québec’s Law 25 goes further: before communicating personal information outside Québec, a business must assess the privacy risks — including the protection offered where the data is going — and put a written agreement in place. Other provinces have their own rules. This guide is general information, not legal advice.',
        ],
        sources: [
          { href: 'https://www.priv.gc.ca/en/privacy-topics/airports-and-borders/gl_dab_090127/', label: 'OPC — processing personal data across borders' },
          { href: 'https://www.cai.gouv.qc.ca/espace-evolutif-modernisation-lois/thematiques/communication-renseignements-personnels-hors-quebec/', label: 'Commission d’accès à l’information — communication outside Québec' },
        ],
      },
      {
        heading: 'How Digby answers them',
        tone: 'inverse',
        paragraphs: ['Digby stores accounts, conversations, memory and files in Canada; processes your prompts with open-weight models running on Canadian hardware; gives you visible, editable memory and deletable conversations; and offers self-hosting for organisations that want everything on their own infrastructure.'],
        links: [
          { href: '/learn/where-your-data-goes', label: 'Where your data goes, step by step' },
          { href: '/private-ai', label: 'Private AI with Digby' },
        ],
      },
    ],
    faqs: [
      { q: 'Is it illegal to use an AI tool hosted outside Canada?', a: 'Generally no — Canadian law allows processing abroad, but the organisation stays accountable, and Québec requires a privacy assessment and written agreement first. Get advice for your situation.' },
      { q: 'Does “stored in Canada” mean the AI runs in Canada?', a: 'Not necessarily. Ask separately where the model that processes your prompts runs.' },
    ],
    related: ['learn/where-your-data-goes', 'learn/what-is-sovereign-ai', 'learn/ai-at-work-in-canada-checklist', 'ai-for-business'],
  },
  {
    slug: 'open-weight-vs-closed-ai-models',
    nav: 'Open vs closed models',
    topic: 'Models',
    title: 'Open-weight vs closed AI models: what’s the difference?',
    description: 'Open-weight versus closed AI models — quality, cost, privacy and lock-in compared in plain language, and why open weights matter for Canadians.',
    h1: 'Open-weight vs closed AI models',
    lede: 'The AI behind a chatbot is either closed — available only through its maker — or open-weight, published so anyone can run it. The difference shapes privacy, cost, reliability and control.',
    keywords: ['open weight vs closed ai models', 'open source ai models', 'open weight models', 'kimi glm deepseek qwen'],
    published: '2026-10-14',
    updated: '2026-10-16',
    readMinutes: 6,
    askPlaceholder: 'Ask about open models…',
    card: 'Quality, cost, privacy and lock-in compared in plain language.',
    prompts: ['Open vs closed models in one paragraph', 'Can open models run on my own server?'],
    sections: [
      {
        heading: 'What “open-weight” means',
        paragraphs: [
          'A model’s weights are the billions of numbers it learned during training. When they are published, anyone with the hardware can run the model — a cloud provider, a Canadian data centre, or your own server. Closed models are reachable only through their maker’s service.',
          '“Open-weight” is not always the same as “open source”: some models publish weights but not training data or code, and licences vary. For running a model where you choose, the weights are what matter.',
        ],
      },
      {
        heading: 'How they compare',
        bullets: [
          'Quality — the best open-weight models are now competitive with leading closed models on many everyday and expert tasks.',
          'Control — open models can be hosted where you choose; closed models run where their vendor runs them.',
          'Lock-in — switching between open models is routine; leaving a closed ecosystem can be hard.',
          'Cost — open models can be served by competing providers, which tends to push prices down.',
          'Privacy — with open weights, the company hosting the model can be one you trust, in a jurisdiction you choose.',
        ],
      },
      {
        heading: 'Where closed models still lead',
        paragraphs: ['On some of the hardest benchmarks and newest capabilities, the largest closed models often arrive first. The gap has been narrowing quickly, and for most everyday work — writing, summarising, research with sources, coding help — well-chosen open models are more than capable.'],
      },
      {
        heading: 'Why not just pick one?',
        tone: 'inverse',
        paragraphs: ['Different models are good at different things, and every model is sometimes confidently wrong. Using several — routing each question to a good fit and letting one model check another — gives better answers than any single model alone.'],
        links: [{ href: '/learn/how-digby-double-checks-answers', label: 'How Digby double-checks answers' }],
      },
    ],
    faqs: [
      { q: 'Are open-weight models safe to use?', a: 'The safety of a model depends on how it is tuned and deployed. Hosting an open model yourself or with a trusted provider also means your prompts go only where you choose.' },
      { q: 'Can I run an open model on my laptop?', a: 'Smaller ones, yes. The strongest open models need data-centre GPUs, which is why Canadian hosting matters.' },
    ],
    related: ['open-source-ai', 'sovereign-ai', 'chatgpt-alternative', 'learn/what-is-sovereign-ai'],
  },
  {
    slug: 'choosing-a-private-ai-chatbot',
    nav: 'Choosing a private AI chatbot',
    topic: 'Privacy',
    title: 'How to choose a private AI chatbot in Canada (2026 guide)',
    description: 'What to look for in a private AI chatbot in Canada: where data is stored and processed, memory controls, deletion, training, model choice and family safety.',
    h1: 'How to choose a private AI chatbot in Canada',
    lede: 'Privacy is now a feature you can choose. A checklist for picking an AI assistant that respects your data — without compromising on usefulness.',
    keywords: ['private ai chatbot canada', 'best private ai chatbot', 'secure ai chatbot', 'canadian ai chatbot'],
    published: '2026-10-14',
    updated: '2026-10-16',
    readMinutes: 5,
    askPlaceholder: 'Ask about private chatbots…',
    card: 'Storage, memory controls, deletion, model choice and family safety.',
    prompts: ['What do you remember about me?', 'How do I delete my chat history?'],
    sections: [
      {
        heading: 'The checklist',
        bullets: [
          'Storage — where is my data stored? Look for a clear answer, ideally Canada.',
          'Processing — where does the model that reads my prompt run?',
          'Memory — can I see what it remembers? It should be visible and editable.',
          'Deletion — can I delete conversations and my account?',
          'Training — is my content used to train models, and can I opt out?',
          'Sharing — is it opt-in and revocable?',
          'Models — which models does it use, and can it switch?',
          'Accuracy — does it show sources and check its answers?',
          'Family — is there a safe mode for children?',
        ],
      },
      {
        heading: 'Read the settings, not just the homepage',
        paragraphs: [
          'The real answers live in settings and help pages: look for a data-controls or privacy screen, check whether memory is on by default, and find out how long deleted chats are kept. A provider that explains this plainly is usually one that thought about it.',
          'Then test it: ask the assistant what it remembers about you, and delete a conversation to see what happens.',
        ],
      },
      {
        heading: 'Usefulness still matters',
        tone: 'inverse',
        paragraphs: ['A private chatbot you never use protects nothing. Make sure it handles your real work: files, web research, writing, and the tools you already use.'],
        links: [
          { href: '/features', label: 'What Digby can do' },
          { href: '/private-ai', label: 'Digby’s privacy approach' },
        ],
      },
    ],
    faqs: [
      { q: 'What is the most private way to use AI?', a: 'Running open-weight models on infrastructure you control. For most people, a service that stores data and runs models in Canada, with visible memory and real deletion, is the practical choice.' },
    ],
    related: ['private-ai', 'learn/where-your-data-goes', 'learn/canadian-data-residency-ai', 'digby-kids'],
  },
  {
    slug: 'ai-at-work-in-canada-checklist',
    nav: 'AI at work checklist',
    topic: 'Work',
    title: 'Using AI at work in Canada: a practical checklist',
    description: 'A practical checklist for Canadian organisations adopting AI assistants — data, models, access, accuracy, policy and exit planning. Not legal advice.',
    h1: 'Using AI at work in Canada: a checklist',
    lede: 'Your team already uses AI. This checklist helps you choose and roll out an assistant deliberately — so it helps the work without creating new risk.',
    keywords: ['ai policy canada business', 'ai at work canada', 'pipeda ai', 'law 25 ai', 'ai governance canada'],
    published: '2026-10-14',
    updated: '2026-10-16',
    readMinutes: 7,
    askPlaceholder: 'Ask about AI at work…',
    card: 'Data, models, access, accuracy and exit planning for Canadian organisations.',
    prompts: ['Draft an AI-use policy for my team', 'What should we ask an AI vendor?'],
    sections: [
      {
        heading: 'Data',
        bullets: ['Where is data stored at rest, and in which jurisdiction?', 'Where is it processed?', 'Is customer content used for training?', 'Can users and admins delete data?'],
      },
      {
        heading: 'Models',
        bullets: ['Which models are used, and who operates them?', 'Can you change models without changing vendors?', 'Is there a self-hosted path for sensitive workloads?'],
      },
      {
        heading: 'Access and sharing',
        bullets: ['Are shared workspaces role-based?', 'Are integrations scoped to what each user can already access?', 'Is public sharing opt-in and revocable?'],
      },
      {
        heading: 'Accuracy',
        bullets: ['Does the tool cite sources?', 'Can answers be checked independently?', 'Is it clear when an answer is uncertain?'],
      },
      {
        heading: 'Policy and people',
        bullets: [
          'Write a one-page AI-use policy — what may go in, what must stay out, who reviews outputs before they leave the building.',
          'Name an owner — someone who approves new integrations and answers staff questions.',
          'Train briefly — ten minutes on checking sources and spotting a confident wrong answer saves hours later.',
          'Review quarterly — tools change fast; revisit vendors, settings and the policy.',
        ],
      },
      {
        heading: 'Exit plan',
        tone: 'inverse',
        bullets: ['Can you export your data?', 'What happens to data when you leave?', 'Are you locked into one model provider?'],
        links: [
          { href: '/ai-for-business', label: 'Digby for Canadian businesses' },
          { href: '/self-hosted-ai', label: 'Self-hosted Digby' },
        ],
      },
      {
        heading: 'Not legal advice',
        paragraphs: ['Obligations under PIPEDA, Québec’s Law 25 and other provincial laws depend on your organisation and data. Consult your privacy officer or counsel.'],
        links: [{ href: '/learn/canadian-data-residency-ai', label: 'What the law expects on data residency' }],
      },
    ],
    related: ['ai-for-business', 'learn/canadian-data-residency-ai', 'digby-vs-microsoft-copilot', 'self-hosted-ai'],
  },
  {
    slug: 'how-digby-double-checks-answers',
    nav: 'How Digby checks answers',
    topic: 'Models',
    shot: 'sources',
    title: 'How Digby double-checks AI answers — and why it matters',
    description: 'AI models are sometimes confidently wrong. How Digby plans each question, searches the web and uses an independent second model to check what matters.',
    h1: 'How Digby double-checks answers',
    lede: 'Every AI model is sometimes confidently wrong. Digby’s answer is a process: plan the question, ground it in sources, and have a different model check the answers that matter.',
    keywords: ['ai hallucinations', 'accurate ai answers', 'ai fact checking', 'ai double check'],
    published: '2026-10-14',
    updated: '2026-10-16',
    readMinutes: 5,
    askPlaceholder: 'Ask how Digby checks answers…',
    card: 'How Digby plans, searches and uses a second model to check what matters.',
    prompts: ['Did a second model check this answer?', 'Dig deeper on: are heat pumps worth it in Ontario?'],
    sections: [
      {
        heading: 'Why AI gets things wrong',
        paragraphs: ['Language models predict plausible text. Most of the time plausible and true coincide; sometimes they don’t, and the model sounds just as sure. Facts that changed recently, numbers, names and anything contested are where errors cluster.'],
      },
      {
        heading: 'Plan the question',
        paragraphs: ['Before answering, Digby decides what kind of question it is: a quick lookup, an ordinary question, something contested or high-stakes, or a research request. That decides how much work the answer gets.'],
      },
      {
        heading: 'Ground it',
        paragraphs: ['When facts are time-sensitive, disputed or beyond what a model knows, Digby searches the live web and cites what it found. The sources appear under the answer so you can open them.'],
      },
      {
        heading: 'Check it',
        tone: 'inverse',
        paragraphs: ['On contested or high-stakes questions, an independent model — a different one from the model that answered — reviews the answer behind the scenes. If it finds a real problem, the answer is updated and you can see what changed.'],
      },
      {
        heading: 'Go deeper on request',
        paragraphs: ['Tap “Dig deeper” under any answer to escalate it to an independent check, then to a full research council of models.'],
        links: [{ href: '/deep-research', label: 'Deep research' }],
      },
    ],
    faqs: [
      { q: 'Does every answer get a second check?', a: 'No — quick, low-stakes questions get a fast answer. Contested or high-stakes ones are checked, and you can ask for a check on any answer with “Dig deeper”.' },
      { q: 'Can Digby still be wrong?', a: 'Yes. Checking reduces errors but doesn’t eliminate them, which is why Digby shows its sources.' },
    ],
    related: ['deep-research', 'open-source-ai', 'learn/open-weight-vs-closed-ai-models', 'features'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookups + navigation
// ─────────────────────────────────────────────────────────────────────────────

export function getSitePage(slug: string): SitePage | undefined {
  return SITE_PAGES.find((p) => p.slug === slug);
}

export function getLearnArticle(slug: string): LearnArticle | undefined {
  return LEARN_ARTICLES.find((a) => a.slug === slug);
}

export interface RelatedCard {
  href: string;
  label: string;
  description: string;
  /** Mono kind label: "Product", "Canada", "Company", "Guide · 6 min". */
  kind: string;
}

const GROUP_KIND: Record<SitePage['group'], string> = { product: 'Product', canada: 'Canada', compare: 'Compare', company: 'Company', local: 'City · Canada' };

/** Resolve a related-slug ('features' | 'learn/x') to a card, or null when it names nothing. */
export function resolveRelated(slug: string): RelatedCard | null {
  if (slug.startsWith('learn/')) {
    const a = getLearnArticle(slug.slice('learn/'.length));
    return a ? { href: `/learn/${a.slug}`, label: a.nav, description: a.card ?? a.description, kind: `Guide · ${a.readMinutes} min` } : null;
  }
  const p = getSitePage(slug);
  return p ? { href: `/${p.slug}`, label: p.nav, description: p.card ?? p.description, kind: GROUP_KIND[p.group] } : null;
}

/** Header navigation on md+ (kept short — the menu + footer carry everything). */
export const HEADER_NAV: ContentLink[] = [
  { href: '/features', label: 'Features' },
  { href: '/private-ai', label: 'Private AI' },
  { href: '/sovereign-ai', label: 'Sovereign AI' },
  { href: '/learn', label: 'Learn' },
  { href: '/about', label: 'About' },
];

/** The full-screen menu's primary list. */
export const MENU_PRIMARY: ContentLink[] = [...HEADER_NAV, { href: '/faq', label: 'FAQ' }];

/** The menu's product cards (title + one-line subtitle). */
export const MENU_PRODUCTS: { href: string; label: string; sub: string }[] = [
  { href: '/deep-research', label: 'Deep research', sub: 'Sourced reports' },
  { href: '/ai-coding-agent', label: 'Digby Code', sub: 'AI coding agent' },
  { href: '/integrations', label: 'Integrations', sub: 'Your tools' },
  { href: '/open-source-ai', label: 'Open models', sub: 'Custom-tuned' },
  { href: '/self-hosted-ai', label: 'Self-hosted', sub: 'Your servers' },
  { href: '/digby-kids', label: 'Digby Kids', sub: 'Safe tutor' },
  { href: '/download', label: 'Download', sub: 'Web, Mac, Windows' },
];

/** Footer columns — every public page is reachable from every public page. */
export function footerColumns(): { title: string; links: ContentLink[] }[] {
  const byGroup = (g: SitePage['group']) => SITE_PAGES.filter((p) => p.group === g).map((p) => ({ href: `/${p.slug}`, label: p.nav }));
  return [
    { title: 'Product', links: byGroup('product') },
    { title: 'Canada', links: byGroup('canada') },
    { title: 'Compare', links: byGroup('compare') },
    // City × vertical layer: 30 generated pages live here rather than in the
    // header, so the menu stays short and every page still has a static path
    // from every other page.
    { title: 'City & sector', links: byGroup('local') },
    { title: 'Learn', links: [{ href: '/learn', label: 'All guides' }, ...LEARN_ARTICLES.map((a) => ({ href: `/learn/${a.slug}`, label: a.nav }))] },
    {
      title: 'Company',
      links: [
        ...byGroup('company'),
        { href: '/privacy', label: 'Privacy Policy' },
        { href: '/terms', label: 'Terms of Service' },
        { href: `mailto:${CONTACT_EMAIL}`, label: 'Contact' },
      ],
    },
  ];
}

/** Every indexable public path (sitemap + interlink tests). */
export function publicPaths(): string[] {
  return [
    '/',
    ...SITE_PAGES.map((p) => `/${p.slug}`),
    '/learn',
    ...LEARN_ARTICLES.map((a) => `/learn/${a.slug}`),
    '/privacy',
    '/terms',
  ];
}

/** Learn articles for a `?topic=` filter (case-insensitive); unknown / empty = all. */
export function learnArticlesForTopic(topic: string | null | undefined): { topic: LearnTopic | null; articles: LearnArticle[] } {
  const match = LEARN_TOPICS.find((t) => t.toLowerCase() === String(topic ?? '').toLowerCase()) ?? null;
  return { topic: match, articles: match ? LEARN_ARTICLES.filter((a) => a.topic === match) : LEARN_ARTICLES };
}

/**
 * Split a bullet into a bold lead line + the rest (redesign spec): text before
 * " — " or ": " when that lead is 2–40 chars, else a first short sentence
 * (8–60 chars ending in "."), else no lead.
 */
export function splitLead(text: string): { lead: string; rest: string } {
  let m = /^(.{2,40}?)( — |: )(.+)$/s.exec(text);
  if (m) return { lead: m[1], rest: m[3] };
  m = /^(.{8,60}?\.)\s(.+)$/s.exec(text);
  if (m) return { lead: m[1], rest: m[2] };
  return { lead: '', rest: text };
}
