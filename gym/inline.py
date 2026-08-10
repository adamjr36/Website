#!/usr/bin/env python3
"""Re-inline gym.r8.css / gym.r8.js into index.html (single-file build).

index.html is the DEPLOYED artifact and embeds copies of the css/js between
marker comments. Edit gym.r8.css / gym.r8.js, then run this to refresh
index.html. The single-file build exists because sibling-asset requests
404'd on some clients (2026-08-10, root cause unproven) while the document
request was always reliable.
"""
import pathlib, re, sys

d = pathlib.Path(__file__).parent
html = (d / 'index.html').read_text()
css = (d / 'gym.r8.css').read_text()
js = (d / 'gym.r8.js').read_text()

for name in ('gym.r8.css', 'gym.r8.js'):
    body = css if name.endswith('css') else js
    if '</script>' in body or '</style>' in body or '<!--' in body:
        sys.exit(f'{name} contains an HTML-breaking sequence; fix before inlining')

html, n1 = re.subn(
    r'(<!-- gym\.r8\.css inlined.*?-->\n      <style>\n).*?(\n      </style>)',
    lambda m: m.group(1) + css + m.group(2), html, count=1, flags=re.S)
html, n2 = re.subn(
    r'(<!-- gym\.r8\.js inlined \(single-file build\) -->\n      <script>\n).*?(\n      </script>)',
    lambda m: m.group(1) + js + m.group(2), html, count=1, flags=re.S)
if n1 != 1 or n2 != 1:
    sys.exit(f'marker match failure (css={n1}, js={n2}) — index.html markers changed?')

(d / 'index.html').write_text(html)
print(f'index.html refreshed: {len(html)} bytes')
