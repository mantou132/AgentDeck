---
name: chart
description: Show charts, diagrams and math in the AgentDeck client. Use whenever the user asks to plot, chart, graph or visualize numbers (trends, comparisons, proportions, distributions, relationships), or when a flowchart, sequence, state, class, ER or architecture diagram, or a formula would explain better than prose; answer with an `agentdeck-chart` fenced block holding an Apache ECharts option for data, a `mermaid` fenced block for diagrams and LaTeX for math, instead of image files, HTML files, ASCII art or other visualization tools.
---

# AgentDeck charts

The AgentDeck client renders a fenced code block with the `agentdeck-chart` language as an interactive Apache ECharts chart, in place, inside your reply. The block body is the ECharts `option` passed to `setOption`.

````markdown
```agentdeck-chart
{
  "title": { "text": "Weekly visits" },
  "tooltip": { "trigger": "axis" },
  "legend": {},
  "xAxis": { "type": "category", "data": ["Mon", "Tue", "Wed", "Thu", "Fri"] },
  "yAxis": { "type": "value" },
  "series": [
    { "name": "Mobile", "type": "line", "data": [120, 146, 132, 178, 205] },
    { "name": "Desktop", "type": "line", "data": [98, 104, 99, 120, 131] }
  ]
}
```
````

## Format

- The body is one strict JSON object: no comments, trailing commas, functions or JavaScript expressions. Use ECharts string templates (e.g. `"{b}: {c}%"`) where a formatter is needed.
- Any built-in series type works (`line`, `bar`, `pie`, `scatter`, `radar`, `heatmap`, `candlestick`, `funnel`, `gauge`, `sankey`, `treemap`, `sunburst`, `boxplot`, ...), except `map` / `geo`, since no map data is registered.
- Always include `tooltip` (`"trigger": "axis"` for axis charts, `"item"` otherwise), and `legend` when there is more than one series.
- Put data inline in the option (`series[].data`, axis `data` or `dataset.source`); nothing can be loaded from URLs.

## Rules

- The chart is shown on phones about 350px wide and 300px tall: keep labels short, rely on `legend` and `tooltip` instead of outside pie labels (`"label": { "show": false }` or `"position": "inside"`), and avoid `toolbox`, fixed sizes and custom colors or backgrounds, which the client themes.
- If a data-visualization design skill (such as `dataviz`) is available, follow it for choosing the chart form, encoding and labeling, but keep this skill's constraints: render with `agentdeck-chart`, and leave colors and backgrounds to the client theme.
- Write the block directly in your reply; do not create files or call tools to draw the chart.
- Keep data to what the chart needs (at most a few hundred points); aggregate larger data first.
- Do not repeat the plotted numbers as a table or list; add at most one or two sentences with the takeaway.

## Diagrams and math

The client also renders standard Markdown extensions in place:

- A fenced block with the `mermaid` language is drawn as a Mermaid diagram. Use it for structure and flow (flowcharts, sequences, states, classes, ER, architecture); keep `agentdeck-chart` for numeric data. Prefer top-down layouts and short node labels for narrow screens.
- LaTeX between `$...$` or `\(...\)` renders inline, and between `$$...$$` or `\[...\]` as a block.
