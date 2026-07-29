import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Search, X, Filter, Calendar, ListFilter, Plus, Check, AlertTriangle,
  Clock, MapPin, User, BookOpen, Trash2, ChevronDown, ChevronUp, Layers,
  GraduationCap, Link as LinkIcon, Info,
} from 'lucide-react';
import COURSES from './courses.js';

/* ------------------------------------------------------------------ */
/*  Constants & helpers                                                */
/* ------------------------------------------------------------------ */

const DAYS = [
  { key: 'M', label: 'Monday', short: 'Mon' },
  { key: 'T', label: 'Tuesday', short: 'Tue' },
  { key: 'W', label: 'Wednesday', short: 'Wed' },
  { key: 'Th', label: 'Thursday', short: 'Thu' },
  { key: 'F', label: 'Friday', short: 'Fri' },
  { key: 'S', label: 'Saturday', short: 'Sat' },
];

const GRID_START = 8 * 60; // 08:00
const GRID_END = 20 * 60; // 20:00
const PX_PER_MIN = 1.05;

const STORAGE_KEY = 'course-scheduler:v1';

const toMin = (t) => {
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
};

const fromMin = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Colors keyed by branch so the same department always reads the same. */
const PALETTE = [
  { bg: 'bg-sky-100', text: 'text-sky-900', border: 'border-sky-400', dot: 'bg-sky-500' },
  { bg: 'bg-emerald-100', text: 'text-emerald-900', border: 'border-emerald-400', dot: 'bg-emerald-500' },
  { bg: 'bg-violet-100', text: 'text-violet-900', border: 'border-violet-400', dot: 'bg-violet-500' },
  { bg: 'bg-amber-100', text: 'text-amber-900', border: 'border-amber-400', dot: 'bg-amber-500' },
  { bg: 'bg-teal-100', text: 'text-teal-900', border: 'border-teal-400', dot: 'bg-teal-500' },
  { bg: 'bg-blue-100', text: 'text-blue-900', border: 'border-blue-400', dot: 'bg-blue-500' },
  { bg: 'bg-indigo-100', text: 'text-indigo-900', border: 'border-indigo-400', dot: 'bg-indigo-500' },
  { bg: 'bg-lime-100', text: 'text-lime-900', border: 'border-lime-400', dot: 'bg-lime-500' },
  { bg: 'bg-fuchsia-100', text: 'text-fuchsia-900', border: 'border-fuchsia-400', dot: 'bg-fuchsia-500' },
  { bg: 'bg-cyan-100', text: 'text-cyan-900', border: 'border-cyan-400', dot: 'bg-cyan-500' },
];

const colorFor = (branch) => {
  let h = 0;
  for (let i = 0; i < branch.length; i++) h = (h * 31 + branch.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/** Split "SANJAY MITTAL (I), Rachana Agrawal(O)" into clean names. */
const splitInstructors = (raw) =>
  (raw || '')
    .split(/,(?![^(]*\))/)
    .map((s) => s.replace(/\((I|O|C)\)/gi, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/**
 * Enrich every raw record once: slot taxonomy, credit total, searchable blob.
 * "OE-1 DC / FIRST-HALF" -> slot "OE-1", family "OE", categories ["DC"], term "FIRST-HALF"
 */
const enrich = (c) => {
  const [left, term = 'REGULAR'] = c.slotType.split(/\s+\/\s+/);
  const tokens = left.trim().split(' ');
  const categories = (tokens.pop() || '').split(',').map((s) => s.trim()).filter(Boolean);
  const slot = tokens.join(' ') || '—';
  const family = slot.replace(/[\s-]?\d+.*$/, '').trim() || slot;
  const creditMatch = c.credits.match(/\((\d+)\)/);
  const instructors = splitInstructors(c.instructor);
  const days = [...new Set(c.sessions.flatMap((s) => s.days))];
  const venues = [...new Set(c.sessions.map((s) => s.venue).filter(Boolean))];
  const starts = c.sessions.map((s) => toMin(s.start));
  const ends = c.sessions.map((s) => toMin(s.end));

  return {
    ...c,
    slot,
    slotFamily: family,
    categories,
    term,
    totalCredits: creditMatch ? Number(creditMatch[1]) : 0,
    instructors,
    days,
    venues,
    earliest: starts.length ? Math.min(...starts) : null,
    latest: ends.length ? Math.max(...ends) : null,
    hasPrereq: Boolean(c.prerequisite && c.prerequisite.trim()),
    search: `${c.code} ${c.name} ${c.branch} ${c.section}`.toLowerCase(),
  };
};

const ALL_COURSES = COURSES.map(enrich);

const uniqSorted = (values) => [...new Set(values)].filter(Boolean).sort();

const FACETS = {
  branches: uniqSorted(ALL_COURSES.map((c) => c.branch)),
  categories: uniqSorted(ALL_COURSES.flatMap((c) => c.categories)),
  slotFamilies: uniqSorted(ALL_COURSES.map((c) => c.slotFamily)),
  terms: uniqSorted(ALL_COURSES.map((c) => c.term)),
  venues: uniqSorted(ALL_COURSES.flatMap((c) => c.venues)),
  instructors: uniqSorted(ALL_COURSES.flatMap((c) => c.instructors)),
  maxCredits: Math.max(...ALL_COURSES.map((c) => c.totalCredits)),
};

const EMPTY_FILTERS = {
  q: '',
  branches: [],
  categories: [],
  slotFamilies: [],
  terms: [],
  venues: [],
  instructor: '',
  days: [],
  creditMin: 0,
  creditMax: FACETS.maxCredits,
  timeStart: GRID_START,
  timeEnd: GRID_END,
  prereq: 'any', // 'any' | 'yes' | 'no'
  hideConflicting: false,
  hideUnscheduled: false,
};

/* ---- conflict detection ------------------------------------------- */

const sessionsOverlap = (a, b) =>
  a.days.some((d) => b.days.includes(d)) &&
  toMin(a.start) < toMin(b.end) &&
  toMin(b.start) < toMin(a.end);

/** Every overlapping (session, session) pair between two courses. */
const clashDetails = (a, b) => {
  const hits = [];
  for (const sa of a.sessions) {
    for (const sb of b.sessions) {
      if (!sessionsOverlap(sa, sb)) continue;
      const days = sa.days.filter((d) => sb.days.includes(d));
      hits.push({
        days,
        window: `${sa.start}–${sa.end}`,
        other: `${sb.start}–${sb.end}`,
      });
    }
  }
  return hits;
};

const timingSummary = (c) =>
  c.sessions.length
    ? c.sessions
        .map((s) => `${s.days.join('/')} ${s.start}–${s.end}${s.venue ? ` @ ${s.venue}` : ''}`)
        .join(' · ')
    : 'No scheduled meeting time';

const loadState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds : [],
      filters: { ...EMPTY_FILTERS, ...(parsed.filters || {}) },
      tab: parsed.tab === 'timetable' ? 'timetable' : 'browse',
    };
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/*  Small UI pieces                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, icon: Icon, children, defaultOpen = true, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-200 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold text-slate-700 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
      >
        {Icon && <Icon className="h-4 w-4 text-slate-400" aria-hidden="true" />}
        <span className="flex-1">{title}</span>
        {badge > 0 && (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
            {badge}
          </span>
        )}
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** Checkbox list with an optional inline search box for long facets. */
function MultiSelect({ options, selected, onChange, searchable = false, label, counts }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  const toggle = (value) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <div>
      {searchable && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${label}…`}
          aria-label={`Search ${label}`}
          className="mb-2 w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
      )}
      <div className="max-h-44 space-y-1 overflow-y-auto pr-1" role="group" aria-label={label}>
        {shown.length === 0 && <p className="text-xs text-slate-400">No matches</p>}
        {shown.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-slate-700 hover:bg-slate-100 focus-within:ring-2 focus-within:ring-sky-500"
          >
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => toggle(option)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
            />
            <span className="flex-1 truncate" title={option}>
              {option}
            </span>
            {counts && <span className="text-[10px] text-slate-400">{counts[option] ?? 0}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

function Pill({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${children}`}
        className="rounded-full hover:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Filter panel                                                       */
/* ------------------------------------------------------------------ */

function FilterPanel({ filters, setFilters, resultCount, onClear, activeCount }) {
  const patch = (delta) => setFilters((f) => ({ ...f, ...delta }));

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <Filter className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-semibold text-slate-800">Filters</h2>
        <button
          type="button"
          onClick={onClear}
          disabled={activeCount === 0}
          className="rounded-md px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Clear all
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8">
        <div className="sticky top-0 z-[5] -mx-4 bg-sky-50/90 px-4 py-2 text-xs font-medium text-sky-800 backdrop-blur">
          {resultCount} of {ALL_COURSES.length} courses match
        </div>

        <div className="relative py-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={filters.q}
            onChange={(e) => patch({ q: e.target.value })}
            placeholder="Search code or title…"
            aria-label="Search course code or name"
            className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
        </div>

        <Section title="Branch / Department" icon={GraduationCap} badge={filters.branches.length}>
          <MultiSelect
            label="branches"
            searchable
            options={FACETS.branches}
            selected={filters.branches}
            onChange={(branches) => patch({ branches })}
          />
        </Section>

        <Section title="Course type" icon={Layers} badge={filters.categories.length} defaultOpen={false}>
          <MultiSelect
            label="course types"
            options={FACETS.categories}
            selected={filters.categories}
            onChange={(categories) => patch({ categories })}
          />
        </Section>

        <Section title="Slot group" icon={ListFilter} badge={filters.slotFamilies.length} defaultOpen={false}>
          <MultiSelect
            label="slot groups"
            searchable
            options={FACETS.slotFamilies}
            selected={filters.slotFamilies}
            onChange={(slotFamilies) => patch({ slotFamilies })}
          />
        </Section>

        <Section title="Term" icon={Calendar} badge={filters.terms.length} defaultOpen={false}>
          <MultiSelect
            label="terms"
            options={FACETS.terms}
            selected={filters.terms}
            onChange={(terms) => patch({ terms })}
          />
        </Section>

        <Section
          title="Credits"
          icon={BookOpen}
          defaultOpen={false}
          badge={filters.creditMin > 0 || filters.creditMax < FACETS.maxCredits ? 1 : 0}
        >
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-slate-500">Min</span>
              <input
                type="number"
                min={0}
                max={FACETS.maxCredits}
                value={filters.creditMin}
                onChange={(e) =>
                  patch({ creditMin: Math.min(Number(e.target.value) || 0, filters.creditMax) })
                }
                className="w-full rounded-md border border-slate-300 px-2 py-1 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-slate-500">Max</span>
              <input
                type="number"
                min={0}
                max={FACETS.maxCredits}
                value={filters.creditMax}
                onChange={(e) =>
                  patch({
                    creditMax: Math.max(
                      Number(e.target.value) || 0,
                      filters.creditMin
                    ),
                  })
                }
                className="w-full rounded-md border border-slate-300 px-2 py-1 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
            </label>
          </div>
        </Section>

        <Section title="Instructor" icon={User} defaultOpen={false} badge={filters.instructor ? 1 : 0}>
          <input
            type="search"
            list="instructor-options"
            value={filters.instructor}
            onChange={(e) => patch({ instructor: e.target.value })}
            placeholder="Type or pick a name…"
            aria-label="Filter by instructor"
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <datalist id="instructor-options">
            {FACETS.instructors.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Section>

        <Section title="Days & time" icon={Clock} badge={
          filters.days.length + (filters.timeStart > GRID_START || filters.timeEnd < GRID_END ? 1 : 0)
        }>
          <div className="mb-3 flex flex-wrap gap-1">
            {DAYS.map((d) => {
              const on = filters.days.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    patch({
                      days: on
                        ? filters.days.filter((x) => x !== d.key)
                        : [...filters.days, d.key],
                    })
                  }
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                    on
                      ? 'border-sky-500 bg-sky-500 text-white'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          <label className="block text-[11px] text-slate-500" htmlFor="time-start">
            Not before {fromMin(filters.timeStart)}
          </label>
          <input
            id="time-start"
            type="range"
            min={GRID_START}
            max={GRID_END}
            step={15}
            value={filters.timeStart}
            onChange={(e) =>
              patch({ timeStart: Math.min(Number(e.target.value), filters.timeEnd - 15) })
            }
            className="w-full accent-sky-600"
          />
          <label className="block text-[11px] text-slate-500" htmlFor="time-end">
            Not after {fromMin(filters.timeEnd)}
          </label>
          <input
            id="time-end"
            type="range"
            min={GRID_START}
            max={GRID_END}
            step={15}
            value={filters.timeEnd}
            onChange={(e) =>
              patch({ timeEnd: Math.max(Number(e.target.value), filters.timeStart + 15) })
            }
            className="w-full accent-sky-600"
          />
        </Section>

        <Section title="Venue" icon={MapPin} badge={filters.venues.length} defaultOpen={false}>
          <MultiSelect
            label="venues"
            searchable
            options={FACETS.venues}
            selected={filters.venues}
            onChange={(venues) => patch({ venues })}
          />
        </Section>

        <Section title="Other" icon={Info} defaultOpen={false} badge={
          (filters.prereq !== 'any' ? 1 : 0) +
          (filters.hideConflicting ? 1 : 0) +
          (filters.hideUnscheduled ? 1 : 0)
        }>
          <fieldset className="mb-3">
            <legend className="mb-1 text-[11px] text-slate-500">Has prerequisite</legend>
            <div className="flex gap-1">
              {['any', 'yes', 'no'].map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={filters.prereq === v}
                  onClick={() => patch({ prereq: v })}
                  className={`flex-1 rounded-md border px-2 py-1 text-[11px] capitalize focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                    filters.prereq === v
                      ? 'border-sky-500 bg-sky-500 text-white'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 py-1 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={filters.hideConflicting}
              onChange={(e) => patch({ hideConflicting: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
            />
            Hide courses that clash with my timetable
          </label>
          <label className="flex items-center gap-2 py-1 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={filters.hideUnscheduled}
              onChange={(e) => patch({ hideUnscheduled: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
            />
            Hide courses with no meeting time
          </label>
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Course card                                                        */
/* ------------------------------------------------------------------ */

function CourseCard({ course, added, conflicts, onToggle }) {
  const blocked = !added && conflicts.length > 0;
  const color = colorFor(course.branch);
  const reason = blocked
    ? `Clashes with ${conflicts
        .map((c) => `${c.code} (${clashDetails(course, c)
          .map((h) => `${h.days.join('/')} ${h.window}`)
          .join(', ')})`)
        .join('; ')}`
    : '';

  return (
    <li
      className={`rounded-lg border bg-white p-3 shadow-sm transition ${
        blocked ? 'border-slate-200 opacity-60' : 'border-slate-200 hover:border-sky-300 hover:shadow'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${color.dot}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-semibold text-slate-900">{course.code}</span>
            {course.section && (
              <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-600">
                Sec {course.section}
              </span>
            )}
            <span className="text-[11px] font-medium text-slate-500">{course.branch}</span>
            <span className="text-[11px] text-slate-400">{course.credits}</span>
          </div>
          <h3 className="truncate text-sm text-slate-800" title={course.name}>
            {course.name}
          </h3>
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-slate-500" title={course.instructor}>
            <User className="h-3 w-3 shrink-0" aria-hidden="true" />
            {course.instructors.join(', ') || '—'}
          </p>
          <p className="mt-0.5 flex items-start gap-1 text-xs text-slate-500">
            <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="break-words">{timingSummary(course)}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
              {course.slot}
            </span>
            {course.categories.map((cat) => (
              <span key={cat} className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">
                {cat}
              </span>
            ))}
            {course.term !== 'REGULAR' && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                {course.term}
              </span>
            )}
            {course.hasPrereq && (
              <span
                className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700"
                title={course.prerequisite}
              >
                prereq
              </span>
            )}
            {course.fch && course.fch.startsWith('http') && (
              <a
                href={course.fch}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-200"
              >
                <LinkIcon className="h-2.5 w-2.5" aria-hidden="true" /> FCH
              </a>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onToggle(course)}
          disabled={blocked}
          title={blocked ? reason : added ? 'Remove from timetable' : 'Add to timetable'}
          aria-label={blocked ? reason : added ? `Remove ${course.code}` : `Add ${course.code}`}
          className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
            blocked
              ? 'cursor-not-allowed bg-slate-100 text-slate-400'
              : added
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-sky-600 text-white hover:bg-sky-700'
          }`}
        >
          {blocked ? (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          ) : added ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Plus className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {blocked && <p className="mt-2 text-[11px] text-rose-600">{reason}</p>}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Timetable grid                                                     */
/* ------------------------------------------------------------------ */

/** Lay overlapping blocks side-by-side within a day column. */
const assignLanes = (blocks) => {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds = [];
  for (const b of sorted) {
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(b.end);
    } else {
      laneEnds[lane] = b.end;
    }
    b.lane = lane;
  }
  const lanes = Math.max(1, laneEnds.length);
  return { blocks: sorted, lanes };
};

function TimetableGrid({ selected, conflictIds, onRemove, visibleDays }) {
  const byDay = useMemo(() => {
    const map = Object.fromEntries(visibleDays.map((d) => [d.key, []]));
    for (const course of selected) {
      for (const session of course.sessions) {
        for (const day of session.days) {
          if (!map[day]) continue;
          map[day].push({
            course,
            venue: session.venue,
            start: toMin(session.start),
            end: toMin(session.end),
            label: `${session.start}–${session.end}`,
          });
        }
      }
    }
    return Object.fromEntries(
      Object.entries(map).map(([day, blocks]) => [day, assignLanes(blocks)])
    );
  }, [selected, visibleDays]);

  const hours = [];
  for (let m = GRID_START; m < GRID_END; m += 60) hours.push(m);
  const height = (GRID_END - GRID_START) * PX_PER_MIN;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div
          className="grid border-b border-slate-200"
          style={{ gridTemplateColumns: `56px repeat(${visibleDays.length}, minmax(0, 1fr))` }}
        >
          <div />
          {visibleDays.map((d) => (
            <div key={d.key} className="px-2 py-2 text-center text-xs font-semibold text-slate-600">
              {d.label}
            </div>
          ))}
        </div>

        <div
          className="grid"
          style={{ gridTemplateColumns: `56px repeat(${visibleDays.length}, minmax(0, 1fr))` }}
        >
          {/* hour gutter */}
          <div className="relative" style={{ height }}>
            {hours.map((m) => (
              <div
                key={m}
                className="absolute -translate-y-1/2 pr-2 text-right text-[10px] text-slate-400"
                style={{ top: (m - GRID_START) * PX_PER_MIN, width: '100%' }}
              >
                {fromMin(m)}
              </div>
            ))}
          </div>

          {visibleDays.map((d) => {
            const { blocks, lanes } = byDay[d.key];
            return (
              <div
                key={d.key}
                className="relative border-l border-slate-200"
                style={{ height }}
              >
                {hours.map((m) => (
                  <div
                    key={m}
                    className="absolute w-full border-t border-slate-100"
                    style={{ top: (m - GRID_START) * PX_PER_MIN }}
                  />
                ))}
                {blocks.map((b, i) => {
                  const color = colorFor(b.course.branch);
                  const clashing = conflictIds.has(b.course.id);
                  return (
                    <button
                      key={`${b.course.id}-${i}`}
                      type="button"
                      onClick={() => onRemove(b.course.id)}
                      title={`${b.course.code} — ${b.course.name}\n${b.label}${
                        b.venue ? ` @ ${b.venue}` : ''
                      }\nClick to remove`}
                      className={`absolute overflow-hidden rounded border-l-4 px-1.5 py-1 text-left transition hover:z-10 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 ${
                        clashing
                          ? 'border-rose-500 bg-rose-100 text-rose-900 ring-1 ring-rose-400'
                          : `${color.border} ${color.bg} ${color.text}`
                      }`}
                      style={{
                        top: (b.start - GRID_START) * PX_PER_MIN + 1,
                        height: Math.max((b.end - b.start) * PX_PER_MIN - 2, 18),
                        left: `calc(${(b.lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      }}
                    >
                      <span className="block truncate font-mono text-[10px] font-bold">
                        {b.course.code}
                      </span>
                      <span className="block truncate text-[9px] leading-tight opacity-80">
                        {b.label}
                      </span>
                      {b.venue && (
                        <span className="block truncate text-[9px] leading-tight opacity-70">
                          {b.venue}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Root component                                                     */
/* ------------------------------------------------------------------ */

export default function CourseTimetableApp() {
  const restored = useRef(loadState()).current;
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(restored?.tab ?? 'browse');
  const [filters, setFilters] = useState(restored?.filters ?? EMPTY_FILTERS);
  const [selectedIds, setSelectedIds] = useState(restored?.selectedIds ?? []);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Nothing async to wait on, but the empty first paint keeps the
  // loading state honest if the data module ever grows a fetch.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ selectedIds, filters, tab }));
    } catch {
      /* storage unavailable — session-only is fine */
    }
  }, [selectedIds, filters, tab]);

  const selected = useMemo(
    () => selectedIds.map((id) => ALL_COURSES.find((c) => c.id === id)).filter(Boolean),
    [selectedIds]
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  /* conflicts among the courses already in the timetable */
  const { conflictPairs, conflictIds } = useMemo(() => {
    const pairs = [];
    const ids = new Set();
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const hits = clashDetails(selected[i], selected[j]);
        if (!hits.length) continue;
        pairs.push({ a: selected[i], b: selected[j], hits });
        ids.add(selected[i].id);
        ids.add(selected[j].id);
      }
    }
    return { conflictPairs: pairs, conflictIds: ids };
  }, [selected]);

  const totalCredits = selected.reduce((sum, c) => sum + c.totalCredits, 0);

  const clashesFor = useCallback(
    (course) => selected.filter((s) => s.id !== course.id && clashDetails(course, s).length > 0),
    [selected]
  );

  const results = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const instructorQ = filters.instructor.trim().toLowerCase();

    return ALL_COURSES.filter((c) => {
      if (q && !c.search.includes(q)) return false;
      if (filters.branches.length && !filters.branches.includes(c.branch)) return false;
      if (filters.categories.length && !c.categories.some((x) => filters.categories.includes(x)))
        return false;
      if (filters.slotFamilies.length && !filters.slotFamilies.includes(c.slotFamily)) return false;
      if (filters.terms.length && !filters.terms.includes(c.term)) return false;
      if (c.totalCredits < filters.creditMin || c.totalCredits > filters.creditMax) return false;
      if (instructorQ && !c.instructors.some((n) => n.toLowerCase().includes(instructorQ)))
        return false;
      if (filters.prereq === 'yes' && !c.hasPrereq) return false;
      if (filters.prereq === 'no' && c.hasPrereq) return false;
      if (filters.venues.length && !c.venues.some((v) => filters.venues.includes(v))) return false;

      const timeNarrowed = filters.timeStart > GRID_START || filters.timeEnd < GRID_END;
      const needsSchedule =
        filters.days.length > 0 || timeNarrowed || filters.hideUnscheduled;
      if (needsSchedule && c.sessions.length === 0) return false;

      if (filters.days.length && !c.days.some((d) => filters.days.includes(d))) return false;
      if (timeNarrowed && c.sessions.length) {
        // every meeting must sit inside the requested window
        const fits = c.sessions.every(
          (s) => toMin(s.start) >= filters.timeStart && toMin(s.end) <= filters.timeEnd
        );
        if (!fits) return false;
      }
      if (filters.hideConflicting && !selectedSet.has(c.id) && clashesFor(c).length) return false;

      return true;
    });
  }, [filters, selectedSet, clashesFor]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.q.trim()) n++;
    n += filters.branches.length + filters.categories.length + filters.slotFamilies.length;
    n += filters.terms.length + filters.venues.length + filters.days.length;
    if (filters.instructor.trim()) n++;
    if (filters.creditMin > 0 || filters.creditMax < FACETS.maxCredits) n++;
    if (filters.timeStart > GRID_START || filters.timeEnd < GRID_END) n++;
    if (filters.prereq !== 'any') n++;
    if (filters.hideConflicting) n++;
    if (filters.hideUnscheduled) n++;
    return n;
  }, [filters]);

  const toggleCourse = (course) =>
    setSelectedIds((ids) =>
      ids.includes(course.id) ? ids.filter((i) => i !== course.id) : [...ids, course.id]
    );

  const visibleDays = useMemo(() => {
    const used = new Set(selected.flatMap((c) => c.days));
    const base = DAYS.filter((d) => d.key !== 'S');
    return used.has('S') ? DAYS : base;
  }, [selected]);

  const untimedSelected = selected.filter((c) => c.sessions.length === 0);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 text-sm text-slate-500">
        <Clock className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Loading course catalog…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="z-20 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-3 px-4 py-3">
          <Calendar className="h-5 w-5 text-sky-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">Course Filter &amp; Timetable Builder</h1>
            <p className="truncate text-xs text-slate-500">
              Pre-registration catalog · {ALL_COURSES.length} courses
            </p>
          </div>

          <div className="hidden items-center gap-3 sm:flex">
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
              {selected.length} course{selected.length === 1 ? '' : 's'}
            </span>
            <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
              {totalCredits} credits
            </span>
            {conflictPairs.length > 0 && (
              <span className="rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">
                {conflictPairs.length} clash{conflictPairs.length === 1 ? '' : 'es'}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setSidebarOpen((o) => !o)}
            className="rounded-md border border-slate-300 p-2 text-slate-600 lg:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            aria-label="Toggle filters"
            aria-expanded={sidebarOpen}
          >
            <Filter className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex gap-1 px-4" aria-label="Views">
          {[
            { id: 'browse', label: 'Browse courses', icon: ListFilter },
            { id: 'timetable', label: 'My timetable', icon: Calendar },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                tab === id
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
              {id === 'timetable' && selected.length > 0 && (
                <span className="rounded-full bg-sky-100 px-1.5 text-[10px] text-sky-700">
                  {selected.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside
          className={`${
            sidebarOpen ? 'block' : 'hidden'
          } absolute inset-x-0 top-[104px] bottom-0 z-20 overflow-y-auto border-r border-slate-200 bg-white lg:static lg:block lg:w-80 lg:shrink-0`}
        >
          <FilterPanel
            filters={filters}
            setFilters={setFilters}
            resultCount={results.length}
            activeCount={activeFilterCount}
            onClear={() => setFilters(EMPTY_FILTERS)}
          />
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {tab === 'browse' ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <p className="text-sm text-slate-600">
                  <strong className="text-slate-900">{results.length}</strong> course
                  {results.length === 1 ? '' : 's'}
                  {activeFilterCount > 0 && ' matching your filters'}
                </p>
                {filters.branches.map((b) => (
                  <Pill
                    key={b}
                    onRemove={() =>
                      setFilters((f) => ({ ...f, branches: f.branches.filter((x) => x !== b) }))
                    }
                  >
                    {b}
                  </Pill>
                ))}
                {filters.categories.map((c) => (
                  <Pill
                    key={c}
                    onRemove={() =>
                      setFilters((f) => ({ ...f, categories: f.categories.filter((x) => x !== c) }))
                    }
                  >
                    {c}
                  </Pill>
                ))}
              </div>

              {results.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
                  <Search className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium text-slate-700">
                    No courses match your filters
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Try widening the time window or clearing a facet.
                  </p>
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_FILTERS)}
                    className="mt-4 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700"
                  >
                    Clear all filters
                  </button>
                </div>
              ) : (
                <ul className="grid gap-2 xl:grid-cols-2">
                  {results.map((course) => (
                    <CourseCard
                      key={course.id}
                      course={course}
                      added={selectedSet.has(course.id)}
                      conflicts={clashesFor(course)}
                      onToggle={toggleCourse}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Total credits</p>
                  <p className="text-lg font-semibold text-emerald-700">{totalCredits}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Courses</p>
                  <p className="text-lg font-semibold text-slate-800">{selected.length}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedIds([])}
                  disabled={selected.length === 0}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 disabled:hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Clear timetable
                </button>
              </div>

              {conflictPairs.length > 0 && (
                <div
                  role="alert"
                  className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3"
                >
                  <p className="flex items-center gap-2 text-sm font-semibold text-rose-800">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    {conflictPairs.length} scheduling conflict
                    {conflictPairs.length === 1 ? '' : 's'}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-rose-700">
                    {conflictPairs.map(({ a, b, hits }) => (
                      <li key={`${a.id}-${b.id}`}>
                        <strong className="font-mono">{a.code}</strong> ↔{' '}
                        <strong className="font-mono">{b.code}</strong> —{' '}
                        {hits
                          .map((h) => `${h.days.join('/')} ${h.window} vs ${h.other}`)
                          .join('; ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
                  <Calendar className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium text-slate-700">Your timetable is empty</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Add courses from the Browse tab to see them here.
                  </p>
                  <button
                    type="button"
                    onClick={() => setTab('browse')}
                    className="mt-4 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700"
                  >
                    Browse courses
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <TimetableGrid
                      selected={selected}
                      conflictIds={conflictIds}
                      onRemove={(id) => setSelectedIds((ids) => ids.filter((x) => x !== id))}
                      visibleDays={visibleDays}
                    />
                    <p className="mt-2 text-[11px] text-slate-400">
                      Click any block to remove that course.
                    </p>
                  </div>

                  {untimedSelected.length > 0 && (
                    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold text-slate-600">
                        No fixed meeting time
                      </p>
                      <ul className="flex flex-wrap gap-2">
                        {untimedSelected.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedIds((ids) => ids.filter((x) => x !== c.id))
                              }
                              title="Click to remove"
                              className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
                            >
                              {c.code} · {c.branch}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <ul className="mt-4 grid gap-2 xl:grid-cols-2">
                    {selected.map((course) => (
                      <CourseCard
                        key={course.id}
                        course={course}
                        added
                        conflicts={[]}
                        onToggle={toggleCourse}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
