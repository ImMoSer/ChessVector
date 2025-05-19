// src/core/i18n.service.ts
import logger from '../utils/logger';

type Translations = {
  [key: string]: string | Translations;
};

type LanguageStore = {
  [lang: string]: Translations;
};

let translations: LanguageStore = {
  en: {},
};

let currentLang = 'en';
const subscribers = new Set<() => void>();

function resolveKey(obj: Translations, keyPath: string): string | undefined {
  const keys = keyPath.split('.');
  let current: string | Translations | undefined = obj;
  for (const k of keys) {
    if (typeof current === 'object' && current !== null && k in current) {
      current = (current as Translations)[k];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function t(key: string, replacements?: Record<string, string | number>): string {
  const langTranslations = translations[currentLang];
  if (!langTranslations) {
    logger.warn(`[i18n] No translations loaded for current language: ${currentLang}`);
    return key;
  }

  let translatedString = resolveKey(langTranslations, key);

  if (translatedString === undefined) {
    logger.warn(`[i18n] Translation key not found: "${key}" for language: "${currentLang}"`);
    translatedString = key;
  }

  if (replacements) {
    for (const placeholder in replacements) {
      translatedString = translatedString.replace(
        new RegExp(`\\{${placeholder}\\}`, 'g'),
        String(replacements[placeholder])
      );
    }
  }
  return translatedString;
}

/**
 * Asynchronously loads translation files for a given language using fetch.
 * Translation files are expected to be in JSON format in the /public/locales/ directory.
 * @param lang The language code (e.g., "en", "ru").
 */
export async function loadTranslations(lang: string): Promise<void> {
  try {
    // Files in the `public` directory are served at the root.
    // So, /locales/en.json will be accessible at `http://<your-server>/locales/en.json`
    const response = await fetch(`/locales/${lang}.json`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} for /locales/${lang}.json`);
    }
    const data = await response.json();
    translations[lang] = data;
    logger.info(`[i18n] Translations for "${lang}" loaded successfully via fetch.`);
  } catch (error) {
    logger.error(`[i18n] Failed to load translations for language: ${lang} using fetch`, error);
    if (lang !== 'en' && (!translations[lang] || Object.keys(translations[lang]).length === 0)) {
       logger.warn(`[i18n] Attempting to load fallback English translations for ${lang} as it failed to load.`);
       if (!translations.en || Object.keys(translations.en).length === 0) {
            await loadTranslations('en');
       }
    }
  }
}

export async function changeLang(lang: string): Promise<void> {
  if (!translations[lang] || Object.keys(translations[lang]).length === 0) {
    logger.info(`[i18n] Translations for "${lang}" not yet loaded. Loading...`);
    await loadTranslations(lang);
  }

  if (translations[lang] && Object.keys(translations[lang]).length > 0) {
    currentLang = lang;
    logger.info(`[i18n] Language changed to: ${lang}`);
    subscribers.forEach(fn => {
      try {
        fn();
      } catch (e) {
        logger.error(`[i18n] Error in language change subscriber:`, e)
      }
    });
  } else {
    logger.error(`[i18n] Could not change to language "${lang}" because its translations failed to load or are empty.`);
  }
}

export function subscribeToLangChange(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getCurrentLang(): string {
  return currentLang;
}

export async function initI18nService(defaultLang: string = 'en'): Promise<void> {
    await loadTranslations(defaultLang);
    if (translations[defaultLang] && Object.keys(translations[defaultLang]).length > 0) {
        currentLang = defaultLang;
        logger.info(`[i18n] Service initialized with default language: ${defaultLang}`);
    } else {
        logger.error(`[i18n] Service initialization failed. Could not load default language: ${defaultLang}. Falling back to key display.`);
    }
}
