/**
 * UI strings for the public site chrome + blocks (2026-10-16 redesign). Pages
 * are English except /ia-souveraine-canada (fr-CA), whose header, menu, ask
 * bar, prompt card, "Keep reading" and footer chrome must read in French too.
 */

export interface SiteStrings {
  startChatting: string;
  startChattingFree: string;
  signIn: string;
  menu: string;
  openMenu: string;
  product: string;
  here: string;
  tryAsking: string;
  keepReading: string;
  swipe: string;
  faqTitle: string;
  ctaTitle: string;
  ctaSub: string;
  askDefault: string;
  askLabel: string;
  send: string;
  seeFeatures: string;
  builtIn: string;
  footerTitles: Record<string, string>;
  menuLabels: Record<string, string>;
  productLabels: Record<string, [string, string]>;
}

const EN: SiteStrings = {
  startChatting: 'Start chatting',
  startChattingFree: 'Start chatting',
  signIn: 'Sign in',
  menu: 'Menu',
  openMenu: 'Open menu',
  product: 'Product',
  here: 'Here',
  tryAsking: 'Try asking Digby',
  keepReading: 'Keep reading',
  swipe: 'Swipe →',
  faqTitle: 'Frequently asked questions',
  ctaTitle: 'Try Digby now.',
  ctaSub: 'No account needed. Models and data stay in Canada.',
  askDefault: 'Ask Digby anything…',
  askLabel: 'Ask Digby',
  send: 'Send',
  seeFeatures: 'See features',
  builtIn: 'Built in Canada',
  footerTitles: {},
  menuLabels: {},
  productLabels: {},
};

const FR: SiteStrings = {
  startChatting: 'Commencer',
  startChattingFree: 'Commencer à discuter',
  signIn: 'Connexion',
  menu: 'Menu',
  openMenu: 'Ouvrir le menu',
  product: 'Produit',
  here: 'Ici',
  tryAsking: 'Essayez de demander à Digby',
  keepReading: 'À lire aussi',
  swipe: 'Glisser →',
  faqTitle: 'Questions fréquentes',
  ctaTitle: 'Essayez Digby dès maintenant.',
  ctaSub: 'Sans compte. Modèles et données restent au Canada.',
  askDefault: 'Posez votre question à Digby…',
  askLabel: 'Demander à Digby',
  send: 'Envoyer',
  seeFeatures: 'Fonctionnalités',
  builtIn: 'Conçu au Canada',
  footerTitles: { Product: 'Produit', Canada: 'Canada', Compare: 'Comparer', Learn: 'Apprendre', Company: 'Entreprise' },
  menuLabels: {
    '/features': 'Fonctionnalités', '/private-ai': 'IA privée', '/sovereign-ai': 'IA souveraine',
    '/learn': 'Apprendre', '/about': 'À propos', '/faq': 'FAQ',
  },
  productLabels: {
    '/deep-research': ['Recherche approfondie', 'Rapports sourcés'],
    '/ai-coding-agent': ['Digby Code', 'Agent de code IA'],
    '/integrations': ['Intégrations', 'Vos outils'],
    '/open-source-ai': ['Modèles ouverts', 'Personnalisés'],
    '/self-hosted-ai': ['Auto-hébergé', 'Vos serveurs'],
    '/digby-kids': ['Digby Kids', 'Tuteur sécuritaire'],
    '/download': ['Télécharger', 'Web, Mac, Windows'],
  },
};

export function siteStrings(lang?: string): SiteStrings {
  return lang?.toLowerCase().startsWith('fr') ? FR : EN;
}

/** "01", "02" … */
export const two = (n: number) => String(n).padStart(2, '0');
