# Stundatöflur

Public timetable site for Háskóli Íslands, served by GitHub Pages.

- **`index.html`** — faculty picker.
- **`von/ fvs/ hug/ mvs/ hvs/`** — one page per faculty, with its timetable
  PDFs in `pdf/`.
- **`oskir/`** — the teacher-wishes page: weeks, times and rooms for a
  course the teacher picks. Static; it talks to an Apps Script endpoint
  that appends to a private Google Sheet.

Everything here is static. No build step, no dependencies.

## Publishing

Settings → Pages → Deploy from branch → `main` / root.

## Adding a timetable PDF

Drop the file in `<faculty>/pdf/` and add a line to that faculty's
`index.html` — each has a commented-out example. The list is maintained by
hand because Pages serves static files with no directory index: a stale
link is visible, whereas a file that quietly stopped being published is
not.

This is the part intended to become automatic — Spoi generating the PDFs
and pushing them here. When it does, the faculty pages should be generated
alongside the files rather than left hand-written, so the two cannot drift.

## The wishes page

`oskir/app.js` has a `CONFIG` block at the top: the endpoint URL, the five
faculties, the week range, the slot grid, and how many rooms a teacher may
name. Two URL parameters are useful for links sent to a faculty:

```
oskir/?school=von        preselects the faculty
oskir/?weeks=2-16        spring term instead of the default 34-47
```

The endpoint URL is public, which is inherent to a link teachers open, and
the same exposure a public Google Form has. Every submission is validated
server-side and only ever appended, so the worst case is junk rows rather
than damage to existing answers.
