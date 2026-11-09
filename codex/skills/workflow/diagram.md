# Diagram style

Start every design diagram with this header. Do not change the colors.

```
digraph design {
  rankdir=LR; bgcolor="#0F172A"; pad=0.4; nodesep=0.5; ranksep=0.9;
  fontname="DejaVu Sans"; fontsize=13; fontcolor="#CBD5E1";
  node [shape=box, style="rounded,filled", fillcolor="#1E293B", color="#38BDF8",
        penwidth=1.4, fontname="DejaVu Sans", fontsize=12, fontcolor="#E2E8F0",
        margin="0.25,0.12"];
  edge [color="#64748B", penwidth=1.3, arrowsize=0.7, fontname="DejaVu Sans",
        fontsize=10, fontcolor="#94A3B8"];
```

Groups use a cluster with this style:

```
  subgraph cluster_x { label="<group>"; style="rounded,dashed"; color="#475569"; ... }
```

Rules:

- Do not set `splines=curved` or `splines=ortho`. They misplace edge labels.
- Mark unverified or optional paths with `style=dashed`.
- Labels are short STE100 noun phrases. Use one term for each thing.
- Render: `dot -Tpng -Gdpi=150 design.dot -o design.png`.
