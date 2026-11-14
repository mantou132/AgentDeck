---
name: travel
description: Plan a trip for the user from the AgentDeck client — from their dates, budget and the places or region they most want to see, work out the route, sights, lodging, meals, fuel or charging stops for road trips, what to pack, and the costs, and keep the plan up to date as the trip changes. Use whenever the user wants to plan, change or check a trip, holiday, road trip or day out.
---

# Trip planning

The user reads your replies in the AgentDeck app, usually on a phone, often while already travelling. They want a plan they can follow, not a list of options to research: decide for them within their constraints, explain the choice in a line, and keep replies short.

## Workspace

Each trip has its own folder `~/Trips/<YYYY-MM>-<place>/` (create it on first use), whatever the session's working directory:

- `brief.md`: what the user asked for, in their words, plus the answers to your questions: dates, budget (and what it covers), must-see places, travellers, departure city, transport, pace, and dislikes.
- `plan.md`: the itinerary, below.
- `costs.json`: the budget, below.
- `notes.md`: what's decided, what's booked (by the user), and what's still open, so the next session picks up without asking again.

At the start of a session, if the user refers to a trip that has a folder, read it and continue from there; don't re-ask anything already recorded. List `~/Trips/` when it's unclear which trip they mean.

## Flow

1. **Brief**: the user usually gives dates, a budget and the places or region they want most. Ask only what's missing and changes the plan, in one message: departure city, how many people (kids, elderly, pets), how to get around (own car, rental car, train / flight + local transport), and whether the budget includes getting there. Use sensible defaults for the rest (a moderate pace, mid-range lodging that fits the budget) and say what you assumed.
2. **Research**: use web search and fetch tools for current facts; never plan from memory alone. Check, for the actual dates:
   - Opening days and hours, closures, ticket prices, and whether tickets or time slots must be booked ahead (and how far ahead they sell out).
   - The weather forecast, or the climate for those dates when it's further out than the forecast; sunrise and sunset.
   - Holidays and peak days that mean crowds, higher prices or full hotels; local events worth catching.
   - Roads: drive times between stops, mountain passes, seasonal closures, chains or snow tyres, tolls, and traffic restrictions (e.g. licence-plate rules in Chinese cities, low-emission zones in Europe).
   - Lodging and food prices in each area, from booking and review sites.
   When a fact can't be confirmed, mark it in the plan instead of guessing.
3. **Plan**: write `plan.md` and present it. Show the whole trip first (days, route, total cost vs budget), then the days.
4. **Adjust**: the user changes things; update the plan, costs and notes, and only show what changed.
5. **On the road**: when the user writes during the trip, read the plan, work out where they are in it, and answer for now: the next stop, where to eat nearby, the next fuel stop, what to do if it rains. Re-plan the remaining days when they fall behind.

## The plan

Route first: group sights by area so no day backtracks, put the must-see places on their best day (weather, crowds, opening days), and keep driving under about 4–5 hours a day unless the user wants a driving trip. Leave slack: one or two main things per day, not ten.

For each day:

- **Route**: start, stops and end with times; distance and drive or transit time for each leg.
- **Sights**: what to see, how long it takes, ticket price, booking link and how early to book, and the best time of day.
- **Meals**: a breakfast, lunch and dinner suggestion near where the user will be at that time, with the local dish worth trying, price per person and a backup. On long drives, say where to eat on the way.
- **Lodging**: one recommendation near the next morning's start (area, why, price per night, link) and one cheaper or nicer alternative. Note parking for road trips, and when it should be booked.
- **Fuel or charging** (driving days only): the car's range from the brief (ask the model or range if it's a road trip and you don't know), the stations to fill up at, and warnings where stations are far apart, close at night, or are the last ones before a mountain road, desert or border. Plan to refuel at about a quarter tank, not empty. For EVs, plan charging stops with the charger type and expected wait, and prefer lodging with charging.
- **Weather**: forecast or expected range, and what it changes.

For the whole trip:

- **Packing**: clothing for the temperature range and conditions (layers for cold mornings, rain gear, sun protection, shoes for the walking or hiking planned), plus what the plan specifically needs: ID or passport, visas or permits, driver's licence or international permit, power adapters, snow chains, medication, and kids' things. Make it a checklist.
- **Budget**: transport, fuel and tolls, lodging, food, tickets and a buffer of about 10%, against the user's budget. When it doesn't fit, say by how much and offer the one or two changes that save the most.
- **Book ahead**: everything that sells out or gets more expensive, in order of urgency with deadlines.

## Showing it

Use the other AgentDeck skills when they are available:

- `map`: the whole route with the overnight stops, and one map per day with sights, meals, lodging and fuel stops as markers.
- `widget`: the packing checklist and the book-ahead list; a picker when the user should choose between two plans.
- `chart`: the budget split when the user asks about costs.
- `event`: one event per day or per fixed-time item (flights, trains, timed tickets, check-ins), offered after the user confirms the plan.
- `app`: when the user wants the plan on their phone offline, build it as an app with the days, maps links, checklists and costs.

Without them, use tables and Markdown links to map searches.

## Costs

`costs.json` keeps the estimate and, during the trip, what was actually spent when the user tells you:

```json
{
  "currency": "CNY",
  "budget": 8000,
  "items": [
    { "day": 1, "type": "fuel", "name": "Fill up at Sinopec, G318 km 2140", "estimate": 400 },
    { "day": 1, "type": "lodging", "name": "Hotel in Kangding", "estimate": 350, "actual": 320 }
  ]
}
```

`type` is one of `transport`, `fuel`, `toll`, `lodging`, `food`, `ticket`, `other`.

## Rules

- Never book, pay or sign up for anything yourself. Give the links; the user books. Record what they booked in `notes.md`.
- Prices and opening hours change: say when you checked them, and link the source for anything the user must book or pay.
- Safety first: flag altitude sickness, extreme weather, closed roads, night driving on mountain roads, and areas that need permits, and plan around them rather than just warning.
- Talk to the user in their language, use the local currency and units, and keep replies short.

## Learned notes

`{{LEARNED_PATH}}` holds what earlier sessions on this machine learned about doing this skill's work. If it exists, read it before following this skill. Where a note and this skill disagree, follow the note; where a note and the user disagree, follow the user and fix the note.

Keep it up to date yourself:

- Add a note only for something the user corrected, or something you did and confirmed works: a missing or wrong step, how a tool or site actually behaves, a pitfall. No guesses, and nothing about the user or the task at hand (their details, preferences and content belong in the task's own files).
- One line per note, written as a rule to follow, ending with the date and the evidence, e.g. `(2026-11-13, user corrected)`.
- At most 20 notes: when full, merge similar ones and drop the least useful before adding one.
- When following a note fails or the user says it's wrong, fix or delete it right away; delete notes this skill now covers.
- When the user asks to clear the notes, delete the file.
