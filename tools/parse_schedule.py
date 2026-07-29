import os, zipfile, re, json, xml.etree.ElementTree as ET
from collections import Counter

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'Course Schedule 2019-202 Semester(Pre-Registration).xlsx')
OUT = os.path.join(ROOT, 'src', 'courses.js')

def colname(ref):
    return re.match(r'[A-Z]+', ref).group(0)

def rows():
    z = zipfile.ZipFile(SRC)
    root = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    for row in root.iter(NS + 'row'):
        d = {}
        for c in row:
            ref = c.get('r')
            t = c.get('t')
            if t == 'inlineStr':
                parts = [n.text or '' for n in c.iter(NS + 't')]
                val = ''.join(parts)
            else:
                v = c.find(NS + 'v')
                val = v.text if v is not None else ''
            val = (val or '').strip()
            if val:
                d[colname(ref)] = val
        yield d

DAYMAP = {'M': 'M', 'T': 'T', 'W': 'W', 'Th': 'Th', 'TH': 'Th', 'F': 'F', 'S': 'S', 'Sa': 'S'}

def parse_time_cell(s, fallback_venue):
    """Returns list of {days, start, end, venue}."""
    if not s:
        return []
    s = re.sub(r'\s+', ' ', s).strip()
    out = []
    # split into chunks that each end with a time range
    # pattern: tokens (day + optional (venue)) followed by HH:MM-HH:MM
    VEN = r'\((?:[^()]|\([^()]*\))*\)'
    chunk_re = re.compile(r'((?:[A-Za-z]{1,2}\s*(?:' + VEN + r')?\s*)+?)(\d{1,2}[:.]\d{2}\s*(?:-|–|to)\s*\d{1,2}[:.]\d{2})')
    for m in chunk_re.finditer(s):
        daypart, timepart = m.group(1), m.group(2)
        tm = re.findall(r'(\d{1,2})[:.](\d{2})', timepart)
        if len(tm) < 2:
            continue
        start = '%02d:%s' % (int(tm[0][0]), tm[0][1])
        end = '%02d:%s' % (int(tm[1][0]), tm[1][1])
        days, venues = [], []
        for dm in re.finditer(r'(Th|TH|[MTWFS])\s*(?:\(((?:[^()]|\([^()]*\))*)\))?', daypart):
            d = DAYMAP.get(dm.group(1))
            if d:
                days.append(d)
                if dm.group(2):
                    venues.append(dm.group(2).strip())
        if not days:
            continue
        venue = venues[0] if venues else (fallback_venue or '')
        # dedupe days preserving order
        seen, dd = set(), []
        for d in days:
            if d not in seen:
                seen.add(d); dd.append(d)
        out.append({'days': dd, 'start': start, 'end': end, 'venue': venue})
    return out

courses = []
unparsed = []
it = rows()
next(it)  # header
for r in it:
    sno = r.get('A')
    name_raw = r.get('C', '')
    if not sno and not name_raw:
        continue
    section = ''
    m = None
    for m2 in re.finditer(r'\(([A-Za-z]{2,6}\s?\d{3}[A-Za-z0-9]*)\)', name_raw):
        m = m2
    if m:
        name = name_raw[:m.start()].strip()
        code = m.group(1).strip()
        section = name_raw[m.end():].strip(' /')
    else:
        m = re.match(r'^(.*?)\(([^()]*)\)\s*$', name_raw)
        if m:
            name, code = m.group(1).strip(), m.group(2).strip()
        else:
            name, code = name_raw.strip(), ''
    sessions = []
    for tcol, vcol in (('I', 'J'), ('K', 'L'), ('M', 'N')):
        raw = r.get(tcol, '')
        parsed = parse_time_cell(raw, r.get(vcol, ''))
        if raw and not parsed:
            unparsed.append(raw)
        sessions.extend(parsed)
    courses.append({
        'id': str(sno or len(courses) + 1),
        'branch': r.get('B', ''),
        'code': code,
        'name': name,
        'section': section,
        'prerequisite': r.get('D', ''),
        'slotType': r.get('E', ''),
        'credits': r.get('F', ''),
        'instructor': r.get('G', ''),
        'instructorEmail': r.get('H', ''),
        'sessions': sessions,
        'fch': r.get('O', ''),
    })

print('courses:', len(courses))
print('no sessions:', sum(1 for c in courses if not c['sessions']))
print('unparsed time cells:', len(unparsed))
for u in Counter(unparsed).most_common(25):
    print('  ', u)
print('branches:', sorted({c['branch'] for c in courses}))
print('slotTypes sample:', sorted({c['slotType'] for c in courses})[:40])
print('credits sample:', sorted({c['credits'] for c in courses})[:30])
with open(OUT, 'w') as f:
    f.write('// Auto-generated from the pre-registration spreadsheet.\n')
    f.write('// Regenerate with: python3 tools/parse_schedule.py\n')
    f.write('const COURSES = ')
    json.dump(courses, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n\nexport default COURSES;\n')
print('wrote', OUT)
