import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import vi from './vi.json';
import en from './en.json';

export const LANG_KEY = 'hris.lang';

void i18n.use(initReactI18next).init({
  resources: {
    vi: { translation: vi },
    en: { translation: en },
  },
  lng: localStorage.getItem(LANG_KEY) ?? 'vi',
  fallbackLng: 'vi',
  interpolation: { escapeValue: false },
});

export function setLanguage(lng: 'vi' | 'en'): void {
  localStorage.setItem(LANG_KEY, lng);
  void i18n.changeLanguage(lng);
}

export default i18n;
