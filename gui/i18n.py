"""
dSIPRouter internationalization (i18n) helpers built on Flask-Babel.
"""

from flask import request, session
from flask_babel import Babel, get_locale as babel_get_locale
import settings

# locale code -> display name (shown in language switcher)
SUPPORTED_LANGUAGES = {
    'zh': '中文',
    'en': 'English',
}

babel = Babel()


def get_locale():
    """
    Resolve the active locale for the current request.

    Priority:
      1. Explicit session choice (set via /set_language)
      2. Configured default (DSIP_DEFAULT_LOCALE, defaults to zh)
      3. Browser Accept-Language (best match among supported locales)
    """
    lang = session.get('lang')
    if lang in SUPPORTED_LANGUAGES:
        return lang

    default = getattr(settings, 'DSIP_DEFAULT_LOCALE', 'zh')
    if default in SUPPORTED_LANGUAGES:
        return default

    return request.accept_languages.best_match(SUPPORTED_LANGUAGES.keys()) or 'zh'


def init_babel(app):
    """Configure Flask-Babel on the given Flask application."""
    app.config['BABEL_DEFAULT_LOCALE'] = getattr(settings, 'DSIP_DEFAULT_LOCALE', 'zh')
    app.config['BABEL_DEFAULT_TIMEZONE'] = getattr(settings, 'DSIP_DEFAULT_TIMEZONE', 'Asia/Shanghai')
    app.config['BABEL_TRANSLATION_DIRECTORIES'] = 'translations'
    app.config['LANGUAGES'] = SUPPORTED_LANGUAGES

    babel.init_app(app, locale_selector=get_locale)

    @app.context_processor
    def inject_i18n():
        return {
            'SUPPORTED_LANGUAGES': SUPPORTED_LANGUAGES,
            'CURRENT_LANGUAGE': str(babel_get_locale() or get_locale()),
        }

    return babel
