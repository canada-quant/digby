/**
 * City × vertical landing pages for digby.ai (2026-10-29 SEO wave, goal 252a1d17
 * todo 75241c35).
 *
 * Ten Canadian metros × the three verticals with the clearest provincial
 * regulatory hook (legal, healthcare, public sector) = 30 pages, generated from
 * the tables below rather than written 30 times.
 *
 * WHY THIS IS NOT A DOORWAY SET. A programmatic page earns its place only when
 * the reader who typed the query gets something they could not get from the
 * generic page. So every page assembles three INDEPENDENTLY DISTINCT blocks:
 *   · the PROVINCE's actual statute for that vertical (6 sets, not one template)
 *   · the CITY's own sector reality (30 distinct passages, no swapped nouns)
 *   · that province's real regulator and what it asks of the organisation
 * and each page clears 500 words of its own copy (pinned by a test).
 *
 * FABRICATION RULE, enforced in the copy itself: the only local hardware fact
 * is the Victoria tuning lab, which is true and appears only on Victoria pages.
 * No city gets an office, a datacenter, a customer or a statistic we do not
 * have. Everything else is the same honest line everywhere: storage in Canada
 * (AWS Canada Central, Montréal), inference on Canadian-located NVIDIA GPU
 * hardware operated in Canada — which is what every Canadian customer gets.
 */
import type { Faq, SitePage } from './content';
import { pricingAnswer } from './pricing';

export type CityVerticalKey = 'legal' | 'healthcare' | 'public-sector';
type RegionKey = 'bc' | 'ab' | 'mb' | 'on' | 'qc' | 'ns';

export interface CityMarket {
  slug: string;
  city: string;
  /** Province name as it reads in a sentence. */
  province: string;
  region: RegionKey;
  /** ASCII province slug, used for the "all <province> pages" link. */
  provinceSlug: string;
  /** Two paragraphs of genuinely local × vertical context, per vertical. */
  context: Record<CityVerticalKey, [string, string]>;
  /** Only where a local hardware fact is TRUE (Victoria). Never invented. */
  proximity?: string[];
}

export const CITY_MARKETS: CityMarket[] = [
  {
    slug: 'victoria',
    city: 'Victoria',
    province: 'British Columbia',
    region: 'bc',
    provinceSlug: 'british-columbia',
    proximity: [
      'Digby is built here: the tuning and evaluation lab where the open models are adapted and tested runs in Victoria, British Columbia. That does not make Victoria queries faster than Toronto ones — inference serves every Canadian customer from the same Canadian-located GPU hardware — but it does mean the people who tune the models are a short drive from the firms and clinics using them.',
    ],
    context: {
      legal: [
        'Victoria is a government town with a small, relationship-driven bar. The firms here are more often a dozen lawyers around a harbour-view table than a Bay Street floor, and the person doing the research is usually the person who will argue the file.',
        'That shape changes what AI is worth. The gain is not replacing research muscle nobody has to spare — it is answering a client’s procedural question at four o’clock without pulling a senior associate off a brief.',
      ],
      healthcare: [
        'Island health care runs through the regional health authority plus a long tail of private clinics, long-term care homes and First Nations health providers — many small enough that the privacy officer is also the office manager.',
        'The paperwork around care is where the hours go: consent forms, referral letters, staff training materials, policy manuals. That is exactly the stack these organisations can put into a private tool without touching clinical judgement.',
      ],
      'public-sector': [
        'As the provincial capital, Victoria holds the ministries, Crown agencies and boards that write and apply British Columbia’s access and privacy law — the same law that governs what they may do with the documents in front of them.',
        'Public bodies here are not shopping for the most impressive model. They are shopping for an answer they can defend in a records-management review and put in front of an access request without a scramble.',
      ],
    },
  },
  {
    slug: 'vancouver',
    city: 'Vancouver',
    province: 'British Columbia',
    region: 'bc',
    provinceSlug: 'british-columbia',
    context: {
      legal: [
        'Vancouver pairs a national-firm presence with a deep bench of boutiques in film, ports and shipping, immigration and Indigenous law. Several practice groups work in more than one language and across time zones before lunch.',
        'The pressure is throughput on document-heavy work — disclosure, contracts, policy review — where the value is finding the right passage fast and showing where it came from.',
      ],
      healthcare: [
        'Metro Vancouver’s care landscape spans acute sites, community clinics, private surgical and diagnostic centres and a large life-sciences sector, much of it regulated as private-sector health information rather than under the hospital statute.',
        'For clinics, the recurring problem is the same document answering the same question for the tenth time: intake rules, fee schedules, accreditation standards, staff onboarding.',
      ],
      'public-sector': [
        'Vancouver’s public bodies run from the city itself to park boards, transit and health authorities — each a separate organisation with its own records obligations and its own procurement process.',
        'Staff at that scale spend real hours answering requests for information they already hold, in documents they cannot easily search.',
      ],
    },
  },
  {
    slug: 'calgary',
    city: 'Calgary',
    province: 'Alberta',
    region: 'ab',
    provinceSlug: 'alberta',
    context: {
      legal: [
        'Calgary’s bar is shaped by energy, corporate and securities work: large in-house teams, heavy contract flow, and firms whose clients expect a considered answer within the hour.',
        'Contract review is the obvious pressure point, but the quieter one is institutional memory — what the firm agreed to on a similar file three years ago, and why.',
      ],
      healthcare: [
        'Alberta delivers health care through a single provincial health authority plus a wide field of primary-care networks, private clinics and continuing-care operators, all handling health information under the province’s own health statute.',
        'Smaller operators rarely have a dedicated privacy function, which makes plain-language policy grounding worth more than a sophisticated model.',
      ],
      'public-sector': [
        'As the province’s corporate capital, Calgary holds a dense mix of public agencies, school boards, and Crown corporations working alongside the energy sector they regulate.',
        'Their records duty is the same as anywhere: answer access requests on time, keep personal information out of things it should not be in, and be able to show how.',
      ],
    },
  },
  {
    slug: 'edmonton',
    city: 'Edmonton',
    province: 'Alberta',
    region: 'ab',
    provinceSlug: 'alberta',
    context: {
      legal: [
        'Edmonton is the province’s legislative and administrative centre, so its legal work leans toward government, administrative law, health law and the Crown side of the table.',
        'Understanding a regulation quickly, and being able to point at the section, is the day-to-day need — more than drafting volume.',
      ],
      healthcare: [
        'Edmonton hosts the provincial health authority’s largest sites alongside a university research hospital ecosystem and a growing private-clinic sector.',
        'Health teams here are used to evidence standards, which is a good instinct to bring to AI: cite the source, show the passage, keep the judgement human.',
      ],
      'public-sector': [
        'The capital region concentrates ministries, boards and agencies, and with them the province’s access-and-privacy machinery in practice rather than theory.',
        'A public body’s honest question about any AI tool is not “is it impressive” but “where does the information sit, and what do we tell a requester”.',
      ],
    },
  },
  {
    slug: 'winnipeg',
    city: 'Winnipeg',
    province: 'Manitoba',
    region: 'mb',
    provinceSlug: 'manitoba',
    context: {
      legal: [
        'Winnipeg’s bar serves a province that is genuinely bilingual in law and administration, with strong practices in family, Aboriginal, labour and agricultural law.',
        'Drafting in both official languages, and finding the right precedent in either, is a routine cost that compounds.',
      ],
      healthcare: [
        'Manitoba delivers care through a shared provincial health organisation plus regional and community operators, all handling personal health information under Manitoba’s health statute.',
        'Rural and northern reach matters here: a tool that helps a smaller site answer a policy question without calling the city is worth more than one that only works well at a tertiary centre.',
      ],
      'public-sector': [
        'Winnipeg holds the provincial government, the city, school divisions and Crown corporations, many of them serving communities hundreds of kilometres away from the office that writes the policy.',
        'The realistic win is consistency: the same rule applied the same way in Thompson and in Winnipeg, with the source document attached.',
      ],
    },
  },
  {
    slug: 'toronto',
    city: 'Toronto',
    province: 'Ontario',
    region: 'on',
    provinceSlug: 'ontario',
    context: {
      legal: [
        'Toronto holds the largest concentration of lawyers in the country, spanning Bay Street firms, litigation boutiques, in-house departments and a very long tail of sole practitioners serving their own communities.',
        'Document volume is the constant: disclosure, closings, regulatory filings, and the client email that needs a careful answer today.',
      ],
      healthcare: [
        'Toronto’s health sector runs from academic hospital networks to community health centres, walk-in clinics and home-care providers, all handling personal health information under Ontario’s health statute.',
        'Most of the staff time is not clinical: it is policies, forms, rosters, training and correspondence, in a city where those documents appear in dozens of languages.',
      ],
      'public-sector': [
        'The city, its agencies and boards, school boards and provincial ministries all operate under Ontario’s municipal and provincial access frameworks, with records obligations that do not pause for volume.',
        'Public bodies in a city this size answer a very large number of routine requests, most of them for information already sitting in a searchable file nobody can search.',
      ],
    },
  },
  {
    slug: 'ottawa',
    city: 'Ottawa',
    province: 'Ontario',
    region: 'on',
    provinceSlug: 'ontario',
    context: {
      legal: [
        'Ottawa’s bar is built around the federal government: regulatory, procurement, immigration, intellectual property and constitutional practice, often with bilingual filing requirements.',
        'Reading a long instrument quickly, and being able to say which provision governs, is most of the work.',
      ],
      healthcare: [
        'Ottawa’s care sector includes hospital networks, community health centres and a substantial bilingual primary-care base, handling health information under Ontario’s statute.',
        'Serving patients in English and French on the same day is routine, and most internal policy exists in both.',
      ],
      'public-sector': [
        'As the federal capital, Ottawa concentrates federal departments and agencies alongside the city and its boards — and with them the expectation that records are findable and answerable in both official languages.',
        'An AI tool introduced here has to handle French as capably as English, not as a translated afterthought.',
      ],
    },
  },
  {
    slug: 'montreal',
    city: 'Montréal',
    province: 'Québec',
    region: 'qc',
    provinceSlug: 'quebec',
    context: {
      legal: [
        'Montréal is a civil-law jurisdiction inside a common-law country, which makes it one of the few places where a legal team routinely works across two legal traditions as well as two languages.',
        'Quebec’s private-sector privacy statute adds obligations that predate most of the rest of the country, so the confidentiality question is sharper here than elsewhere.',
      ],
      healthcare: [
        'Montréal’s care networks are organised into integrated health and social services centres, alongside private clinics and community organisations, under Quebec’s own privacy law.',
        'Bilingual documentation is the norm and translation is a recurring cost — one a tool that answers in either language, from the same source document, can reduce.',
      ],
      'public-sector': [
        'Montréal aggregates the city, its boroughs, school boards and health networks, all working under Quebec’s privacy statute with its own notice and access expectations.',
        'French is the working language of the administration, which makes English-only tooling a non-starter regardless of how good it is.',
      ],
    },
  },
  {
    slug: 'quebec-city',
    city: 'Québec City',
    province: 'Québec',
    region: 'qc',
    provinceSlug: 'quebec',
    context: {
      legal: [
        'Quebec City is the seat of the National Assembly and the province’s courts, so its bar leans to government, insurance, civil litigation and notarial practice.',
        'Work is overwhelmingly in French, and the source texts — the Civil Code, provincial statutes, insurer wordings — are French originals rather than translations.',
      ],
      healthcare: [
        'The capital region’s health and social services network operates under Quebec’s privacy statute, with documentation produced in French first.',
        'For these teams the practical question about any AI tool is whether it reads the French source properly, not whether it can be made to answer in French.',
      ],
      'public-sector': [
        'Québec City holds the ministries and agencies that administer the province, working in French under the provincial privacy statute.',
        'Records obligations here assume French-language documents and French-language answers, which is a real constraint on tooling chosen elsewhere.',
      ],
    },
  },
  {
    slug: 'halifax',
    city: 'Halifax',
    province: 'Nova Scotia',
    region: 'ns',
    provinceSlug: 'nova-scotia',
    context: {
      legal: [
        'Halifax carries Atlantic Canada’s largest legal community alongside a distinct ocean-economy practice in shipping, fisheries, offshore energy and defence procurement.',
        'Firms are smaller than their Ontario counterparts and less able to absorb a research task that eats an afternoon.',
      ],
      healthcare: [
        'Nova Scotia delivers care through a single provincial health authority plus community and private providers, handling health information under the province’s own health statute.',
        'Distance is the defining constraint: a great deal of care and administration happens hours from Halifax, and the policy still has to be applied correctly out there.',
      ],
      'public-sector': [
        'Halifax holds the provincial government, the municipality and the region’s universities and health bodies, operating under the province’s access and privacy framework.',
        'Small teams with wide mandates are the norm — the person answering an access request may also be the person writing the information-management policy.',
      ],
    },
  },
];

/** One entry per vertical; the statute text is per province (below). */
export const CITY_VERTICALS: {
  key: CityVerticalKey;
  slug: CityVerticalKey;
  /** Short label for nav / breadcrumbs. */
  nav: string;
  /** The sector hub page this page reports to. */
  hub: string;
  h1Noun: string;
  audience: string;
  /** Ultra-short audience for the length-pinned <description>. */
  audienceShort: string;
  /** What the tool actually does for this vertical (4 bullets). */
  useCases: string[];
  /** The boundary: what it must not be used for. */
  boundary: string;
  /** A realistic first month, vertical-specific (3 bullets). */
  firstMonth: string[];
}[] = [
  {
    key: 'legal',
    slug: 'legal',
    nav: 'Law firms',
    hub: 'industries-legal',
    h1Noun: 'law firms',
    audience: 'law firms and in-house legal teams',
    audienceShort: 'law firms',
    useCases: [
      'Know-how Q&A — ask the firm’s own manual, precedents and standard forms a question and get the passage it came from.',
      'Matter-file reading — put a closed file in a project and ask what the retainer covered, what the limitation period was, what the client actually instructed.',
      'Contract review support — summarise a draft, list the unusual clauses, and flag where it departs from your standard wording, with the clause quoted.',
      'Research with sources — current statutes and regulations, with links a junior can check before the answer reaches a partner.',
    ],
    boundary: 'Digby does not give legal advice, does not replace a lawyer’s judgement, and must never be the only reader of a document that carries a deadline. It reads and retrieves; a human signs.',
    firstMonth: [
      'Start with know-how, not matters — put the firm manual and standard forms in a project and let people ask about their own procedures first.',
      'Then one closed matter — a file already resolved, so the team can check the answers against the record.',
      'Write the rule down before opening it up — what may go in, what never does, who reviews an output before it is used.',
    ],
  },
  {
    key: 'healthcare',
    slug: 'healthcare',
    nav: 'Health care',
    hub: 'industries-healthcare',
    h1Noun: 'clinics and health teams',
    audience: 'clinics, care homes and health administrators',
    audienceShort: 'clinics',
    useCases: [
      'Policy grounding — ask a question about intake, consent, scheduling or billing and get the passage from your own policy manual.',
      'Administrative drafting — referral letters, patient-facing explanations, staff memos, drafted in plain language and reviewed by a person.',
      'Training material — turn a protocol into a short teaching note, or answer a new hire’s question from the document it came from.',
      'Reporting and planning — summarise operational data a manager pastes in, without sending patient records anywhere they should not go.',
    ],
    boundary: 'Digby is not a medical device, not a diagnostic tool and not clinical decision support. It does not interpret tests, triage patients or recommend treatment. It works on the paperwork around care, never on the clinical judgement itself.',
    firstMonth: [
      'One non-clinical corpus — the policy manual and staff onboarding material, in a project with access limited to the people who already read them.',
      'One workflow, one reviewer — pick a single recurring document type and name the person who checks every draft before it leaves.',
      'Confirm the boundary in writing — state that clinical questions are out of scope, and make sure the whole team has read that line.',
    ],
  },
  {
    key: 'public-sector',
    slug: 'public-sector',
    nav: 'Public sector',
    hub: 'industries-public-sector',
    h1Noun: 'public bodies',
    audience: 'municipalities, agencies and public bodies',
    audienceShort: 'public bodies',
    useCases: [
      'Policy and bylaw Q&A — staff ask in plain language and get the section that answers it, from the current text rather than a memory of it.',
      'Access-request support — find the records that respond to a request, and summarise them, with a person deciding what is released and what is severed.',
      'Briefing preparation — turn a bundle of reports into a short briefing note with the sources attached.',
      'Plain-language service — rewrite a form or a notice so a resident can understand it, in English or in French.',
    ],
    boundary: 'Digby does not decide access requests, does not apply severances, and does not replace the records schedule. It helps staff find and read; the statutory decision stays with the public body and its delegated officer.',
    firstMonth: [
      'Published documents first — start with material that is already public, so nobody debates whether it was allowed.',
      'One team, one question set — prove it on the five questions a front counter actually gets asked.',
      'Bring records management in early — the people who own the schedule should shape what goes into a project.',
    ],
  },
];

/** Provincial statute + regulator, per region per vertical. */
const REGION_LAW: Record<RegionKey, { name: string; legal: { heading: string; paragraphs: string[] }; healthcare: { heading: string; paragraphs: string[] }; 'public-sector': { heading: string; paragraphs: string[] } }> = {
  bc: {
    name: 'British Columbia',
    legal: {
      heading: 'What British Columbia asks of a law firm',
      paragraphs: [
        'A law firm in British Columbia is a private organisation under the Personal Information Protection Act, and separately bound by the Law Society of British Columbia’s rules of professional conduct on confidentiality and client records. Those are two different obligations that happen to point the same way: client information is held in trust, used only for the purpose it was given, and disclosed only where the law or the client requires it.',
        'Solicitor-client privilege survives the tool. Putting a client file into any third-party system is a decision the lawyer makes and must be able to justify — which is why where the information is stored, and who can reach it, is a professional question here and not just an IT one.',
      ],
    },
    healthcare: {
      heading: 'What British Columbia asks of a health provider',
      paragraphs: [
        'Health information in British Columbia is governed by the Freedom of Information and Protection of Privacy Act for public bodies such as health authorities and hospitals, and by the Personal Information Protection Act for private clinics and care providers. Both require a lawful purpose, only the information needed for it, and reasonable security — and the public-body side adds a duty to document the decision.',
        'The practical translation for a clinic: know which statute you are under before you put anything into a tool, and keep the clinical record in the clinical system.',
      ],
    },
    'public-sector': {
      heading: 'What British Columbia asks of a public body',
      paragraphs: [
        'Public bodies in British Columbia operate under the Freedom of Information and Protection of Privacy Act, which sets out both what the public may ask for and what the body must protect. Personal information must be collected for a stated purpose and stored in accordance with the Act’s rules on where it may be kept.',
        'That is why a public body asks about storage location before it asks about model quality: the answer has to survive an access request, a privacy review and a change of government.',
      ],
    },
  },
  ab: {
    name: 'Alberta',
    legal: {
      heading: 'What Alberta asks of a law firm',
      paragraphs: [
        'An Alberta law firm holds client information under the Law Society of Alberta’s rules of professional conduct and, as a private organisation, under the Personal Information Protection Act. Confidentiality is a professional duty owed to the client, independent of any privacy statute.',
        'The question a firm should be able to answer before using any AI tool is the one a client may ask: where is my file, who can see it, and can it be deleted when the matter closes.',
      ],
    },
    healthcare: {
      heading: 'What Alberta asks of a health custodian',
      paragraphs: [
        'Alberta has a dedicated statute for this: the Health Information Act governs how custodians collect, use and disclose health information, with an explicit duty to protect it and, for many uses, a requirement to be able to account for the disclosure.',
        'The Act is specific enough that “we put it in an AI tool” is not an answer to a privacy review. Being able to state where the information is stored, and that inference runs in Canada, is the minimum.',
      ],
    },
    'public-sector': {
      heading: 'What Alberta asks of a public body',
      paragraphs: [
        'Alberta’s public bodies work under the Freedom of Information and Protection of Privacy Act, which requires personal information to be collected directly where practicable and protected with reasonable safeguards.',
        'For a municipality or agency, adopting a tool means adding it to the privacy impact assessment it already runs — not starting a parallel process beside it.',
      ],
    },
  },
  mb: {
    name: 'Manitoba',
    legal: {
      heading: 'What Manitoba asks of a law firm',
      paragraphs: [
        'Manitoba firms answer to the Law Society of Manitoba’s rules on confidentiality and to the Personal Information Protection and Private Documents Act as private organisations. The professional duty is the one that matters most: the client’s information is not the firm’s information.',
        'Bilingual practice adds a second dimension — the same duty applies whether the file is in English or in French, and a tool that only handles one well is half a tool.',
      ],
    },
    healthcare: {
      heading: 'What Manitoba asks of a health trustee',
      paragraphs: [
        'Manitoba’s Personal Health Information Act governs trustees of health information: what may be collected, who it may be disclosed to, and what safeguards are required. It applies to the provincial system and to private providers alike.',
        'Because it covers the whole continuum, a tool adopted by one site with the best intentions can create a problem for another. Consistency across the province is the point.',
      ],
    },
    'public-sector': {
      heading: 'What Manitoba asks of a public body',
      paragraphs: [
        'Manitoba public bodies operate under the Freedom of Information and Protection of Privacy Act, which sets out both the public’s right of access and the body’s duty to protect personal information in its care.',
        'Records often serve communities far from the office that holds them, which makes plain-language internal search worth more than it sounds.',
      ],
    },
  },
  on: {
    name: 'Ontario',
    legal: {
      heading: 'What Ontario asks of a law firm',
      paragraphs: [
        'Ontario law firms are bound by the Law Society of Ontario’s rules of professional conduct on confidential information and by the Personal Information Protection and Electronic Documents Act as a commercial activity. The professional obligation is stricter than the statute and does not bend for convenience.',
        'The Law Society has been explicit that technology is not exempt from these duties: a lawyer who puts client information into a system must understand where it goes and who can reach it.',
      ],
    },
    healthcare: {
      heading: 'What Ontario asks of a health information custodian',
      paragraphs: [
        'The Personal Health Information Protection Act governs health information custodians in Ontario: the circle of care, the duty to protect, and rules on disclosing outside it. It applies to hospitals, clinics, community services and long-term care alike.',
        'Clinical records belong in the clinical system. What a private AI tool can carry is the surrounding material — policies, forms, training, correspondence — where the custodian’s obligation is still to know exactly where that text sits.',
      ],
    },
    'public-sector': {
      heading: 'What Ontario asks of a public body',
      paragraphs: [
        'Ontario public bodies work under the Freedom of Information and Protection of Privacy Act, or the municipal equivalent, which sets the access right and the protection duty in parallel.',
        'Large bodies answer a high volume of routine requests for information they already hold. The bottleneck is rarely the decision; it is finding the records.',
      ],
    },
  },
  qc: {
    name: 'Québec',
    legal: {
      heading: 'What Québec asks of a law firm',
      paragraphs: [
        'Quebec’s private-sector privacy law was modernised ahead of most of the country and carries obligations the rest of Canada is still catching up to: a demonstrated need for the information, explicit purposes, and an expectation of privacy by design. Professional confidentiality is regulated separately by the Barreau du Québec, whose code applies on top.',
        'Because Quebec practice is a civil-law system, the sources a firm researches are also different — the Civil Code and provincial statutes are French originals, and a tool that reads them as translations starts at a disadvantage.',
      ],
    },
    healthcare: {
      heading: 'What Québec asks of a health body',
      paragraphs: [
        'Quebec applies its modernised private-sector privacy statute with specific rules for health and social services information, on top of the professional secrecy that attaches to health records under the provincial framework.',
        'In practice that means the language question and the privacy question arrive together: the working documents are in French, and the obligation follows the information wherever it goes.',
      ],
    },
    'public-sector': {
      heading: 'What Québec asks of a public body',
      paragraphs: [
        'Quebec public bodies work under the provincial privacy statute together with the access rules that govern their documents. The modernised obligations add notice and transparency expectations that a tool used on public documents has to accommodate.',
        'The working language of the administration is French. That is a requirement, not a preference, and it applies to any AI system that touches the work.',
      ],
    },
  },
  ns: {
    name: 'Nova Scotia',
    legal: {
      heading: 'What Nova Scotia asks of a law firm',
      paragraphs: [
        'Nova Scotia firms answer to the Nova Scotia Barristers’ Society’s rules on confidentiality and, as private organisations, to the Personal Information Protection and Electronic Documents Act. The professional duty runs with the file regardless of who hosts the software.',
        'Smaller firms carry the same obligations as large ones with a fraction of the support, which is why plain-language policy grounding beats a sophisticated configuration nobody has time to maintain.',
      ],
    },
    healthcare: {
      heading: 'What Nova Scotia asks of a health custodian',
      paragraphs: [
        'Nova Scotia’s Personal Health Information Act sets out how health information may be collected, used and disclosed, and what safeguards custodians must maintain.',
        'Because care is delivered across a whole province with a small central administration, the safeguards have to be understandable by the people applying them at the far end of a long drive.',
      ],
    },
    'public-sector': {
      heading: 'What Nova Scotia asks of a public body',
      paragraphs: [
        'Nova Scotia public bodies operate under the Freedom of Information and Protection of Privacy Act, which establishes the public’s access right and the body’s protection duty together.',
        'Small teams with wide mandates are usual here: the person answering the request may also be the person who set the retention policy.',
      ],
    },
  },
};

/** Two province-and-vertical questions per region+vertical, answered honestly. */
const REGION_FAQS: Record<RegionKey, Record<CityVerticalKey, Faq[]>> = {
  bc: {
    legal: [
      { q: 'Is a British Columbia law firm allowed to put client documents into an AI tool?', a: 'The Law Society of British Columbia’s confidentiality rules require you to understand where the information goes and who can reach it. Many firms do use tools for research and drafting on non-privileged material first, and decide deliberately about client files — Digby keeps stored data in Canada and can be self-hosted so nothing leaves infrastructure you control.' },
      { q: 'Does PIPEDA apply to a BC law firm as well as the Law Society rules?', a: 'Both can apply. The Law Society rules are a professional duty that does not bend; PIPEDA covers the firm’s commercial handling of personal information. Where they overlap, the stricter obligation governs.' },
    ],
    healthcare: [
      { q: 'Are private clinics in British Columbia under PIPA or FOIPPA?', a: 'Generally PIPA covers private clinics and PIPA does not cover public bodies such as health authorities, which fall under FOIPPA. If you are unsure which applies to your organisation, that is the first thing to settle — before any document goes into any tool.' },
      { q: 'Can Digby be used on clinical records?', a: 'It should not be. Digby is not a medical device and not clinical decision support. Use it on policies, forms, training material and correspondence, and keep the clinical record in the clinical system.' },
    ],
    'public-sector': [
      { q: 'Can a BC public body use a third-party AI service at all?', a: 'FOIPPA sets the conditions, including rules about where personal information may be stored and who may access it. A public body should confirm its own direction on that before adopting a tool; Digby keeps stored data in Canada and self-host it on infrastructure the body controls.' },
      { q: 'Does Digby hold any certification a BC public body can cite?', a: 'No. Digby holds no PIPEDA, SOC 2 or ISO certification. The honest answer in a procurement review is that the architecture is designed to support residency and control requirements, and that no certificate is being offered.' },
    ],
  },
  ab: {
    legal: [
      { q: 'What does the Law Society of Alberta expect when a firm uses AI?', a: 'The rules of professional conduct require confidentiality and competence with the technology you use. Competence in practice means being able to explain where client information is stored and who can access it — which is a question worth asking of any vendor.' },
      { q: 'Can Digby be deployed so an Alberta firm’s files never leave the firm?', a: 'Yes. Digby can be self-hosted with Docker Compose against any OpenAI-compatible model server, on infrastructure the firm controls. The hosted version keeps stored data in Canada (AWS Canada Central, Montréal) and runs inference on Canadian-located GPU hardware.' },
    ],
    healthcare: [
      { q: 'How does the Health Information Act affect using AI in an Alberta clinic?', a: 'The Health Information Act sets out how custodians collect, use and disclose health information and requires safeguards. A tool used on administrative material should be assessed like any other system that touches the custodian’s information — and clinical records stay where they belong.' },
      { q: 'Is Digby a health information custodian?', a: 'No. Digby is a tool used by an organisation; the custodian obligations stay with the clinic or health body that adopts it. That is true of any AI vendor, and it is worth saying plainly.' },
    ],
    'public-sector': [
      { q: 'Does a privacy impact assessment cover an Alberta public body using AI?', a: 'Typically yes — a tool that handles personal information in a new way belongs inside the existing assessment process, not beside it. Digby’s architecture information (storage residency, inference location, self-hosting option) is on the infrastructure page for exactly that exercise.' },
      { q: 'Can an Alberta public body self-host Digby?', a: 'Yes. Self-hosted Digby runs on the body’s own infrastructure with any OpenAI-compatible model server, which keeps both storage and inference under its control.' },
    ],
  },
  mb: {
    legal: [
      { q: 'Do Manitoba lawyers have to be able to work in both English and French with AI?', a: 'Confidentiality obligations apply equally in either language, and a great deal of Manitoba legal work is bilingual. Digby answers in the language you ask in and can work from French source documents rather than translated copies.' },
      { q: 'What should a Manitoba firm check before using AI on client files?', a: 'Where the information is stored, who can reach it, whether it can be deleted, and how you would explain each of those to a client. If a vendor cannot answer all four, that is your answer.' },
    ],
    healthcare: [
      { q: 'What does Manitoba’s Personal Health Information Act require of a trustee using AI?', a: 'PHIA requires trustees to protect health information with reasonable safeguards and to limit collection and use to what is needed. A tool used on policies and training material still has to be assessed, and clinical records should stay in the clinical system.' },
      { q: 'Does Digby store Manitoba patient information?', a: 'It stores whatever an organisation chooses to put into a project, in Canada (AWS Canada Central, Montréal). Our position is that clinical records should not go in — the tool is for the surrounding documents.' },
    ],
    'public-sector': [
      { q: 'How does FIPPA affect an AI tool at a Manitoba public body?', a: 'FIPPA sets the access right and the protection duty together. A tool that helps staff find records for an access request is useful; it does not transfer the body’s decision-making responsibility, and it should not hold personal information outside the body’s control.' },
      { q: 'Can rural Manitoba sites use the same tool as Winnipeg?', a: 'Yes — that is one of the real advantages of a hosted, residency-respecting tool. The same rule is applied the same way regardless of where the office sits, with the source document attached.' },
    ],
  },
  on: {
    legal: [
      { q: 'What do the Law Society of Ontario rules say about AI and client information?', a: 'Confidential information under the rules must be protected, and a lawyer must be competent in the technology they choose to use — which includes understanding where information is stored and who can access it. Those duties apply to the tool, not just to the assistant using it.' },
      { q: 'Can a Toronto firm use Digby for contract review?', a: 'For review support yes — summarising a draft, listing unusual clauses, comparing against your standard wording, with each point quoting the clause. The lawyer reviews and signs; Digby does not give legal advice.' },
    ],
    healthcare: [
      { q: 'Does PHIPA apply to a Toronto walk-in clinic using an AI assistant?', a: 'Yes. A clinic is a health information custodian under PHIPA, and its duties apply to any system that handles personal health information it holds. The workable pattern is to keep clinical records out of the tool and use it for administrative material.' },
      { q: 'Is Digby clinical decision support?', a: 'No. It is not a medical device, does not interpret tests, does not triage and does not recommend treatment. It reads the paperwork around care.' },
    ],
    'public-sector': [
      { q: 'Can a Toronto agency use an AI tool under MFIPPA?', a: 'MFIPPA sets the access right and the protection duty for municipal bodies, and adopting a tool is a records-management decision as much as a technology one. Digby keeps stored data in Canada and can be self-hosted on infrastructure the body controls.' },
      { q: 'Does Digby help answer access requests automatically?', a: 'It helps staff find and summarise records. It does not decide what is released or what is severed — that decision stays with the delegated officer.' },
    ],
  },
  qc: {
    legal: [
      { q: 'What extra obligations does Quebec’s privacy law impose on a law firm?', a: 'Quebec’s modernised private-sector statute asks for a demonstrated need, explicit and stated purposes, and privacy protection designed in from the start — obligations several other provinces are still phasing in. Professional confidentiality under the Barreau du Québec applies on top.' },
      { q: 'Can Digby work from French source documents in Quebec?', a: 'Yes — it reads and answers in French, which matters here because the Civil Code and provincial statutes are French originals rather than translations.' },
    ],
    healthcare: [
      { q: 'Does Digby handle health information under Quebec’s privacy law?', a: 'Digby stores what an organisation puts into a project, in Canada (AWS Canada Central, Montréal). Our position is that health records belong in the clinical system, and the tool should carry the surrounding policy, training and correspondence.' },
      { q: 'Can the tool answer in French and English from the same document?', a: 'Yes. Ask in either language and the answer comes back in it, from the same source passage. For a bilingual health network that removes a recurring translation step.' },
    ],
    'public-sector': [
      { q: 'Is French-language support optional for a Quebec public body?', a: 'No. French is the working language of the administration, so tooling that is English-first is not a candidate regardless of quality. Digby answers in the language it is asked in.' },
      { q: 'Does Digby hold any Quebec certification?', a: 'No. Digby holds no certification under Quebec’s privacy law or any other framework. What it offers is an architecture designed to support residency and control requirements, described honestly on the infrastructure and compliance pages.' },
    ],
  },
  ns: {
    legal: [
      { q: 'What does the Nova Scotia Barristers’ Society expect on confidentiality with AI?', a: 'The rules on confidentiality run with the client file regardless of who hosts the software, and a lawyer is expected to be competent with the tools they use. Understanding where information sits is part of that.' },
      { q: 'Can a small Halifax firm self-host Digby?', a: 'Yes — self-hosted Digby runs with Docker Compose against any OpenAI-compatible model server. Many smaller firms prefer the hosted version and rely on Canadian storage plus deletion controls instead.' },
    ],
    healthcare: [
      { q: 'What does Nova Scotia’s PHIA require of a health custodian?', a: 'PHIA governs collection, use and disclosure of health information and requires custodians to maintain reasonable safeguards. Any new system touching that information should be assessed within the custodian’s existing process.' },
      { q: 'Can Digby help a rural Nova Scotia site apply the same policy as Halifax?', a: 'That is the practical case for it: the policy is in the project, so a site hours from the capital gets the same answer with the same source passage.' },
    ],
    'public-sector': [
      { q: 'How does FIPPA apply to a Nova Scotia municipality using AI?', a: 'FIPPA sets the access right and the protection duty together. A tool that helps staff find records is useful, but it does not move the statutory decision, and personal information should stay within the body’s control.' },
      { q: 'Does Digby offer any certification Nova Scotia procurement can rely on?', a: 'No. No PIPEDA, SOC 2 or ISO certification is held. The defensible ground is architecture — Canadian storage, Canadian inference, and a self-hosted option for infrastructure the body controls.' },
    ],
  },
};

const citySlug = (vertical: CityVerticalKey, marketSlug: string) => `ai-${vertical}-${marketSlug}`;

const titleCase = (s: string) => s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** Word count of a page's own copy (mirrors content.test.ts's depth rule). */
export const cityPageWords = (p: SitePage) =>
  [p.h1, p.lede, ...p.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]), ...(p.faqs ?? []).flatMap((f) => [f.q, f.a])]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;

export function cityPages(): SitePage[] {
  const pages: SitePage[] = [];
  for (const v of CITY_VERTICALS) {
    CITY_MARKETS.forEach((m, i) => {
      const law = REGION_LAW[m.region];
      const statute = law[v.key];
      const [ctx1, ctx2] = m.context[v.key];
      const neighbours = [1, 2, 3].map((step) => CITY_MARKETS[(i + step) % CITY_MARKETS.length]);
      const slug = citySlug(v.slug, m.slug);
      pages.push({
        slug,
        group: 'local',
        updated: '2026-10-29',
        nav: `${titleCase(v.nav.replace(/s$/, ''))} · ${m.city}`,
        title: `AI for ${v.h1Noun} in ${m.city}`,
        description: `Private AI for ${m.city} ${v.audienceShort}: cited answers from your own documents, data stored in Canada, models on Canadian hardware.`,
        eyebrow: `${v.nav} · ${m.city}, ${m.region.toUpperCase()}`,
        h1: `Private AI for ${v.h1Noun} in ${m.city}`,
        lede: `${m.city} ${v.audience} work inside ${law.name}’s own rules. Digby answers from your documents with the passage attached, keeps stored data in Canada, and runs the models on Canadian-located hardware — so the answer is checkable and the question “where does it go” has a short reply.`,
        keywords: [
          `ai for ${v.key === 'public-sector' ? 'public sector' : v.key === 'legal' ? 'law firms' : 'clinics'} ${m.city}`,
          `private ai ${m.city}`,
          `ai ${m.city} ${law.name}`,
          statute.heading.replace('What ', '').replace(' asks of a', '').toLowerCase(),
        ],
        sections: [
          {
            heading: statute.heading,
            paragraphs: statute.paragraphs,
            links: [
              { href: '/compliance', label: `How Digby describes its own limits` },
              { href: `/${v.hub}`, label: `AI for Canadian ${v.key === 'public-sector' ? 'public bodies' : v.key === 'legal' ? 'law firms' : 'health teams'} — the national page` },
            ],
          },
          {
            heading: `${m.city}’s ${v.key === 'public-sector' ? 'public-sector' : v.key === 'legal' ? 'legal' : 'health'} reality`,
            paragraphs: [ctx1, ctx2],
          },
          {
            heading: 'What Digby does — and what we do not claim',
            tone: 'inverse',
            bullets: v.useCases,
            paragraphs: [v.boundary],
          },
          {
            heading: 'Where the data lives, and where the models run',
            paragraphs: [
              `Stored data — accounts, conversations, memory and files — sits in Canada, in AWS Canada Central (Montréal). The models that write answers run on NVIDIA GPU hardware located in Canada and operated from Canada. That second part is the one most vendors gloss: storage residency is not the same claim as inference residency, and for a ${m.city} ${v.key === 'legal' ? 'firm' : v.key === 'healthcare' ? 'clinic' : 'public body'} the difference is exactly the one a privacy review will ask about.`,
              ...(m.proximity ?? []),
              'If the requirement is that nothing leaves infrastructure you control, Digby can be self-hosted with Docker Compose against any OpenAI-compatible model server. That is a different trade — you run it — and it is documented rather than implied.',
            ],
            links: [
              { href: '/infrastructure', label: 'Where Digby’s inference and storage actually are' },
              { href: '/self-hosted-ai', label: 'Run Digby on your own servers' },
              { href: '/private-ai', label: 'What private AI means at Digby' },
            ],
          },
          {
            heading: `A sensible first month for a ${m.city} ${v.key === 'legal' ? 'firm' : v.key === 'healthcare' ? 'clinic' : 'public body'}`,
            bullets: v.firstMonth,
          },
          {
            heading: `Other Canadian cities`,
            paragraphs: [`${m.city} firms and organisations often work across provincial lines, and the statute changes at the border. The same ${v.nav.toLowerCase()} material, set up for the next province over:`],
            links: [
              ...neighbours.map((n) => ({ href: `/${citySlug(v.slug, n.slug)}`, label: `${titleCase(v.nav.replace(/s$/, ''))} · ${n.city}` })),
              { href: '/industries', label: 'AI for every Canadian industry' },
            ],
          },
        ],
        faqs: [
          ...REGION_FAQS[m.region][v.key],
          {
            q: `What does Digby cost for a ${m.city} ${v.key === 'legal' ? 'firm' : v.key === 'healthcare' ? 'clinic' : 'public body'}?`,
            a: pricingAnswer(),
          },
        ],
        related: [v.hub, 'compliance', 'infrastructure', 'private-ai'],
        secondary: { href: `/${v.hub}`, label: `AI for Canadian ${v.key === 'legal' ? 'law firms' : v.key === 'healthcare' ? 'health teams' : 'public bodies'}` },
        card: `${v.nav} in ${m.city}: the ${law.name} rules that apply, and where the data sits.`,
        askPlaceholder: `Ask a ${m.city} ${v.key === 'legal' ? 'practice' : v.key === 'healthcare' ? 'clinic' : 'public-sector'} question…`,
        prompts: [
          v.key === 'legal'
            ? `Summarise this policy and cite the section`
            : v.key === 'healthcare'
              ? `What does our consent policy require at intake?`
              : `Which bylaw section covers this request?`,
          `Answer in French as well`,
        ],
      });
    });
  }
  return pages;
}