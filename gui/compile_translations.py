#!/usr/bin/env python3
"""Compile gettext .po catalogs into binary .mo files (no pybabel required)."""

from __future__ import annotations

import argparse
import struct
from pathlib import Path


def parse_po(text: str) -> dict[str, str]:
    """Parse a simple gettext .po file into msgid -> msgstr mappings."""
    messages: dict[str, str] = {}
    msgid: list[str] | None = None
    msgstr: list[str] | None = None
    mode = None

    def flush():
        nonlocal msgid, msgstr, mode
        if msgid is not None and msgstr is not None:
            key = ''.join(msgid)
            val = ''.join(msgstr)
            if key:  # skip header (empty msgid)
                messages[key] = val
        msgid = None
        msgstr = None
        mode = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('msgid '):
            flush()
            msgid = [_unquote(line[6:])]
            msgstr = None
            mode = 'msgid'
        elif line.startswith('msgstr '):
            msgstr = [_unquote(line[7:])]
            mode = 'msgstr'
        elif line.startswith('"') and mode == 'msgid' and msgid is not None:
            msgid.append(_unquote(line))
        elif line.startswith('"') and mode == 'msgstr' and msgstr is not None:
            msgstr.append(_unquote(line))
    flush()
    return messages


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        s = s[1:-1]
    return (
        s.replace('\\n', '\n')
         .replace('\\t', '\t')
         .replace('\\"', '"')
         .replace('\\\\', '\\')
    )


def write_mo(messages: dict[str, str], path: Path) -> None:
    """Write a GNU gettext .mo file (little-endian, no plurals)."""
    # Include empty header entry required by gettext
    keys = [''] + sorted(k for k in messages if k)
    values = [
        'Content-Type: text/plain; charset=UTF-8\n' if k == '' else messages[k]
        for k in keys
    ]

    key_bytes = [k.encode('utf-8') for k in keys]
    val_bytes = [v.encode('utf-8') for v in values]

    # Header: magic, revision, nstrings, orig_offset, trans_offset, hash_size, hash_offset
    n = len(keys)
    header_size = 7 * 4
    # original table + translation table (each entry: length + offset)
    table_size = n * 8 * 2
    offset = header_size + table_size

    orig_table = []
    for b in key_bytes:
        orig_table.append((len(b), offset))
        offset += len(b) + 1  # NUL terminated

    trans_table = []
    for b in val_bytes:
        trans_table.append((len(b), offset))
        offset += len(b) + 1

    parts = [struct.pack('<Iiiiiii', 0x950412de, 0, n, header_size, header_size + n * 8, 0, 0)]
    for length, off in orig_table:
        parts.append(struct.pack('<II', length, off))
    for length, off in trans_table:
        parts.append(struct.pack('<II', length, off))
    for b in key_bytes:
        parts.append(b + b'\0')
    for b in val_bytes:
        parts.append(b + b'\0')

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b''.join(parts))


def compile_locale(locale_dir: Path) -> Path:
    po_path = locale_dir / 'LC_MESSAGES' / 'messages.po'
    mo_path = locale_dir / 'LC_MESSAGES' / 'messages.mo'
    if not po_path.is_file():
        raise FileNotFoundError(po_path)
    messages = parse_po(po_path.read_text(encoding='utf-8'))
    write_mo(messages, mo_path)
    return mo_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--translations-dir',
        type=Path,
        default=Path(__file__).resolve().parent / 'translations',
        help='Directory containing <locale>/LC_MESSAGES/messages.po',
    )
    args = parser.parse_args()

    compiled = []
    for locale_dir in sorted(p for p in args.translations_dir.iterdir() if p.is_dir()):
        mo = compile_locale(locale_dir)
        compiled.append(mo)
        print(f'compiled {mo}')
    if not compiled:
        raise SystemExit(f'No locales found under {args.translations_dir}')


if __name__ == '__main__':
    main()
