# Course Filter & Timetable Builder

Single-page React app for browsing a university pre-registration catalog, filtering it
every way possible, and assembling a personal weekly timetable with automatic conflict
detection.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production bundle in dist/
npm run preview   # serve the built bundle
```

## Layout

| Path | What it is |
| --- | --- |
| `src/CourseTimetableApp.jsx` | The whole app — single default-export component tree |
| `src/courses.js` | Bundled course catalog (709 records), generated ahead of time |
| `tools/parse_schedule.py` | Regenerates `src/courses.js` from the source spreadsheet |

Regenerate the data after replacing the spreadsheet:

```bash
python3 tools/parse_schedule.py
```

## Data model

Each record is parsed from the pre-registration sheet into:

```js
{
  id, branch, code, name, section, prerequisite, slotType, credits,
  instructor, instructorEmail, fch,
  sessions: [ { days: ["M","W","F"], start: "09:00", end: "10:00", venue: "", kind: "lecture" } ]
}
```

The sheet's three `Time`/`Venue` column pairs hold lecture, tutorial and lab timings. Lecture
and tutorial timings are parsed into the `sessions` array, each tagged with its `kind` (e.g.
`MWF 09:00-10:00`); lab timings are left out. All 582 timed courses parse cleanly; 127
records (projects, theses, UGPs and lab-only courses) carry no meeting time and are grouped
separately in the timetable view. The current sheet has no venue data, so the Venue filter
is hidden until a sheet with rooms is loaded.

The app derives a few fields at load: total credits from `3-0-0-0(5)`, the slot name and
course-type tags from `OE-1 DC / FIRST-HALF`, and an instructor list split out of the
`(I)`/`(O)` annotations.

## Features

**Filters** (all combinable, live result count, clear-all): free-text search over code and
title, branch, course type (DC/DE/OE/PRF/IC/Minor/…), slot group, term, credit range,
instructor (searchable), day of week, start/end time sliders, venue, has-prerequisite
toggle, plus optional "hide anything that clashes with my timetable".

**Results** — cards showing code, section, title, branch, credits, instructor, timing
summary, and tags. Courses that clash with the current timetable are grayed out and
disabled, with a tooltip naming the offending course and the overlapping window.

**Timetable** — Mon–Fri hourly grid (Saturday appears only if a selected course needs it).
Overlapping blocks sit side by side; conflicts are outlined in red and listed in a warning
banner. Click a block to remove the course. Running credit total and a clear-timetable
button sit above the grid.

**Persistence** — the timetable, filter state, and active tab are saved to `localStorage`
and restored on reload.

Colors are keyed by branch so a department always reads the same across the grid; red is
reserved for conflicts.
