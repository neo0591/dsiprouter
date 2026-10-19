# dSIPRouter GUI Translations

Internationalization is powered by [Flask-Babel](https://python-babel.github.io/flask-babel/).

## Layout

```
translations/
  zh/LC_MESSAGES/
    messages.po   # editable Chinese catalog
    messages.mo   # compiled binary (required at runtime)
```

English strings in templates/Python are the source language (`msgid`).
Untranslated strings fall back to English automatically.

## Default language

`DSIP_DEFAULT_LOCALE` in `settings.py` (default: `zh`).
Users can switch language via the top-nav / login language picker (`/set_language/<lang>`).

## Adding or updating strings

1. Wrap UI text with `_('...')` in Jinja templates or Python:
   ```jinja
   {{ _('Dashboard') }}
   ```
   ```python
   from flask_babel import gettext as _
   flash(_('Wrong Username or Password'))
   ```

2. Add the `msgid` / `msgstr` pair to `zh/LC_MESSAGES/messages.po`.

3. Recompile the catalog:
   ```bash
   python gui/compile_translations.py
   ```

   Or with Babel (if installed):
   ```bash
   pybabel compile -d gui/translations
   ```

## Adding a new language

1. Create `translations/<locale>/LC_MESSAGES/messages.po` (copy from `zh` and translate).
2. Register the locale in `gui/i18n.py` → `SUPPORTED_LANGUAGES`.
3. Run `python gui/compile_translations.py`.
