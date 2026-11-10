---
name: event
description: Offer an event the user can add to their phone's calendar in the AgentDeck client. Use when your reply produces something with a date and time worth remembering (a flight, appointment, deadline, booking, launch or a recurring habit such as a daily check-in); answer with an `agentdeck-event` fenced block holding the event, instead of .ics files or calendar tools on this machine.
---

# AgentDeck calendar events

The AgentDeck client renders a fenced code block with the `agentdeck-event` language as an event card. Tapping it opens the phone's own calendar editor prefilled with the event; the user reviews and saves it there. Nothing is added until the user taps and saves, and the client cannot read the calendar.

````markdown
```agentdeck-event
{
  "title": "Flight CA981 to New York",
  "start": "2026-12-01T13:00:00+08:00",
  "end": "2026-12-01T14:30:00-05:00",
  "location": "Beijing Capital International Airport T3",
  "notes": "Booking ref XK29QP, check in by 11:00"
}
```
````

A recurring habit is one event with `recurrence`:

````markdown
```agentdeck-event
{
  "title": "Morning run check-in",
  "start": "2026-12-01T07:00:00+08:00",
  "end": "2026-12-01T07:30:00+08:00",
  "recurrence": { "frequency": "daily", "count": 30 }
}
```
````

## Format

- The body is one strict JSON object: no comments, trailing commas or JavaScript.
- `title` (required): a short event name.
- `start` (required): ISO 8601 date-time with a UTC offset (`2026-12-01T13:00:00+08:00`), using the offset of the place where the event happens. For all-day events use a date (`2026-12-01`) and set `"allDay": true`.
- `end` (optional): same format as `start`; for an all-day event spanning several days, the last day. Without it the calendar uses its default duration.
- `allDay` (optional): `true` for events without a time of day.
- `location`, `notes` (optional): plain text.
- `recurrence` (optional): `frequency` is `daily`, `weekly`, `monthly` or `yearly`; optional `interval` (every N periods, default 1); end it with `count` (number of occurrences) or `until` (a date or date-time in the same format as `start`). Without `count` or `until` it repeats forever.

## Rules

- Only use dates, times and places you know or looked up; ask instead of guessing when the time or time zone is unclear.
- One card per event, with one sentence before it; use `recurrence` instead of separate cards for something that repeats on a regular schedule.
- Do not ask the user to confirm in text or tell them to add it manually; the card is the action.
