#!/usr/bin/env python3
"""
diff_contracts.py — compare deux contract_map.json et produire un diff structuré.

Usage:
    python3 lib/diff_contracts.py <old_path> <new_path> [--out diff.json]

Format contract_map.json attendu (compatible historique):
    {
      "normalized_name": ["TEAM_ABBR", "G+PO", salary_int|null],
      ...
    }

Sortie (JSON sur stdout, ou fichier si --out):
    {
      "old_path": "...", "new_path": "...",
      "summary": {
        "old_count": N, "new_count": N,
        "added": N, "removed": N,
        "contract_changed": N, "salary_changed": N, "team_changed": N
      },
      "added":   [{"name": "...", "team": "X", "contract": "G+PO", "salary": N}, ...],
      "removed": [{"name": "...", "team": "X", "contract": "G+PO", "salary": N}, ...],
      "contract_changed": [{"name": "...", "team": "X", "old": "G+PO", "new": "G+PO", "salary": N}, ...],
      "salary_changed":   [{"name": "...", "team": "X", "contract": "G+PO", "old_salary": N, "new_salary": N, "delta": N}, ...],
      "team_changed":     [{"name": "...", "old_team": "X", "new_team": "Y", "contract": "G+PO", "salary": N}, ...]
    }

Un même joueur peut apparaître dans plusieurs catégories (ex: changement de team + de salaire).
Tri: par valeur absolue de salaire décroissante (les gros mouvements en haut).
"""
import json
import sys
import argparse


def load(path):
    with open(path) as f:
        return json.load(f)


def title(norm):
    """Display-friendly version of a normalized name."""
    return " ".join(p.capitalize() for p in norm.split())


def to_entry(name, tup):
    """Normalize a contract_map tuple to a dict. Accept tuple or list."""
    team = tup[0] if len(tup) > 0 else None
    contract = tup[1] if len(tup) > 1 else None
    salary = tup[2] if len(tup) > 2 else None
    return {"name": title(name), "team": team, "contract": contract, "salary": salary}


def diff(old_map, new_map):
    old_keys = set(old_map)
    new_keys = set(new_map)

    added = []
    removed = []
    contract_changed = []
    salary_changed = []
    team_changed = []

    for k in new_keys - old_keys:
        added.append(to_entry(k, new_map[k]))

    for k in old_keys - new_keys:
        removed.append(to_entry(k, old_map[k]))

    for k in old_keys & new_keys:
        o = old_map[k]
        n = new_map[k]
        o_team, o_ct, o_sal = (o + [None, None, None])[:3]
        n_team, n_ct, n_sal = (n + [None, None, None])[:3]

        if o_ct != n_ct:
            contract_changed.append({
                "name": title(k), "team": n_team,
                "old": o_ct, "new": n_ct, "salary": n_sal,
            })
        if o_sal != n_sal and o_sal is not None and n_sal is not None:
            salary_changed.append({
                "name": title(k), "team": n_team, "contract": n_ct,
                "old_salary": o_sal, "new_salary": n_sal,
                "delta": n_sal - o_sal,
            })
        if o_team != n_team:
            team_changed.append({
                "name": title(k),
                "old_team": o_team, "new_team": n_team,
                "contract": n_ct, "salary": n_sal,
            })

    # Sort by salary magnitude (biggest moves first)
    added.sort(key=lambda e: -(e["salary"] or 0))
    removed.sort(key=lambda e: -(e["salary"] or 0))
    contract_changed.sort(key=lambda e: -(e["salary"] or 0))
    salary_changed.sort(key=lambda e: -abs(e["delta"]))
    team_changed.sort(key=lambda e: -(e["salary"] or 0))

    return {
        "summary": {
            "old_count": len(old_map),
            "new_count": len(new_map),
            "added": len(added),
            "removed": len(removed),
            "contract_changed": len(contract_changed),
            "salary_changed": len(salary_changed),
            "team_changed": len(team_changed),
        },
        "added": added,
        "removed": removed,
        "contract_changed": contract_changed,
        "salary_changed": salary_changed,
        "team_changed": team_changed,
    }


def format_slack(d, limit=15):
    """Produce a compact Slack-ready text block summarizing the diff."""
    s = d["summary"]
    lines = [
        f"*Contrats qui ont bougé* ({s['old_count']} → {s['new_count']}) :",
        f"• ➕ {s['added']} ajouts · ➖ {s['removed']} retraits · 🔄 {s['contract_changed']} contrats · 💵 {s['salary_changed']} sal · 🔁 {s['team_changed']} trades",
    ]

    def fmt_salary(v):
        if v is None:
            return "—"
        if abs(v) >= 1_000_000:
            return f"${v / 1e6:.1f}M"
        if abs(v) >= 1_000:
            return f"${v / 1e3:.0f}K"
        return f"${v}"

    if d["contract_changed"]:
        lines.append("\n*Contrats modifiés* :")
        for p in d["contract_changed"][:limit]:
            lines.append(f"• {p['name']} ({p['team']}): {p['old']} → {p['new']} · {fmt_salary(p['salary'])}")
        if len(d["contract_changed"]) > limit:
            lines.append(f"… +{len(d['contract_changed']) - limit} autres")

    if d["team_changed"]:
        lines.append("\n*Changements d'équipe* :")
        for p in d["team_changed"][:limit]:
            lines.append(f"• {p['name']}: {p['old_team']} → {p['new_team']} · {p['contract']} · {fmt_salary(p['salary'])}")
        if len(d["team_changed"]) > limit:
            lines.append(f"… +{len(d['team_changed']) - limit} autres")

    if d["salary_changed"]:
        lines.append("\n*Salaires modifiés* (top variations) :")
        for p in d["salary_changed"][:limit]:
            sign = "+" if p["delta"] > 0 else ""
            lines.append(f"• {p['name']} ({p['team']}): {fmt_salary(p['old_salary'])} → {fmt_salary(p['new_salary'])} ({sign}{fmt_salary(p['delta'])})")
        if len(d["salary_changed"]) > limit:
            lines.append(f"… +{len(d['salary_changed']) - limit} autres")

    if d["added"]:
        lines.append(f"\n*Nouveaux joueurs ({len(d['added'])})* (top 10 par sal) :")
        for p in d["added"][:10]:
            lines.append(f"• {p['name']} ({p['team']}): {p['contract']} · {fmt_salary(p['salary'])}")
        if len(d["added"]) > 10:
            lines.append(f"… +{len(d['added']) - 10} autres")

    if d["removed"]:
        lines.append(f"\n*Joueurs retirés ({len(d['removed'])})* (top 10 par sal) :")
        for p in d["removed"][:10]:
            lines.append(f"• {p['name']} ({p['team']}): {p['contract']} · {fmt_salary(p['salary'])}")
        if len(d["removed"]) > 10:
            lines.append(f"… +{len(d['removed']) - 10} autres")

    return "\n".join(lines)


def _fmt_salary(v):
    if v is None:
        return "—"
    if abs(v) >= 1_000_000:
        return f"${v / 1e6:.1f}M"
    if abs(v) >= 1_000:
        return f"${v / 1e3:.0f}K"
    return f"${v}"


def format_comment(d):
    """Commentaire narratif auto des mouvements de la semaine (FR), tiré du diff.
    Posté en tête du récap Slack/Discord (points 2 & 3, évolution 2026-07-02)."""
    s = d["summary"]
    lines = [
        (f"📝 *Commentaire de la semaine* — {s['added']} arrivée(s) · {s['removed']} départ(s) · "
         f"{s['contract_changed']} contrat(s) · {s['salary_changed']} salaire(s) · {s['team_changed']} trade(s).")
    ]
    if not any((s['added'], s['removed'], s['contract_changed'], s['salary_changed'], s['team_changed'])):
        lines.append("Aucun mouvement cette semaine — table Spotrac stable (offseason calme).")
        return "\n".join(lines)
    if d["added"]:
        top = [p for p in d["added"] if (p.get("salary") or 0) > 3_000_000][:3]
        if top:
            lines.append("• 🆕 Arrivées notables : " + ", ".join(f"{p['name']} ({_fmt_salary(p['salary'])})" for p in top))
    if d["contract_changed"]:
        lines.append("• 🔄 Contrats : " + ", ".join(f"{p['name']} {p['old']}→{p['new']}" for p in d["contract_changed"][:3]))
    if d["salary_changed"]:
        sc = sorted(d["salary_changed"], key=lambda p: -abs(p["delta"]))[:3]
        lines.append("• 💵 Plus gros mouvements de salaire : " + ", ".join(
            f"{p['name']} {'+' if p['delta'] > 0 else ''}{_fmt_salary(p['delta'])}" for p in sc))
    if d["team_changed"]:
        lines.append("• 🔁 Changements d'équipe : " + ", ".join(
            f"{p['name']} {p['old_team']}→{p['new_team']}" for p in d["team_changed"][:3]))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("old_path")
    ap.add_argument("new_path")
    ap.add_argument("--out", help="Path to write JSON diff (default: stdout)")
    ap.add_argument("--slack", action="store_true", help="Also print Slack-friendly text to stderr")
    ap.add_argument("--comment", action="store_true", help="Also print the auto narrative commentary to stderr (after a ---COMMENT--- marker)")
    args = ap.parse_args()

    old_map = load(args.old_path)
    new_map = load(args.new_path)
    d = diff(old_map, new_map)
    d["old_path"] = args.old_path
    d["new_path"] = args.new_path

    out_text = json.dumps(d, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out_text)
        print(f"Diff écrit dans {args.out}", file=sys.stderr)
    else:
        print(out_text)

    if args.slack:
        print(format_slack(d), file=sys.stderr)

    if args.comment:
        print("---COMMENT---", file=sys.stderr)
        print(format_comment(d), file=sys.stderr)


if __name__ == "__main__":
    main()
