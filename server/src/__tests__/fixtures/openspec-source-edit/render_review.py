#!/usr/bin/env python3
"""Render the review-deck/v2 template from explicit OpenSpec Markdown.

No third-party Python packages or renderer service. The CLI checks native OpenSpec
validation before generation; build_data is also usable in isolated parser tests.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VERSION = "review-deck/v2"
TYPES = ("operator", "infra", "testing", "code", "misc")
DATA_SCRIPT = re.compile(r'(<script\b[^>]*\bid=["\']review-data["\'][^>]*>)(.*?)(</script>)', re.S)


class SourceError(ValueError):
    """An authored source cannot be represented faithfully by the review model."""


def require(condition, message):
    if not condition:
        raise SourceError(message)


def structural_lines(text):
    """Preserve line positions but ignore fenced examples when parsing structure."""
    lines, fence = [], None
    for line in text.splitlines():
        match = re.match(r"^\s*(`{3,}|~{3,})", line)
        if match:
            token = match[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            lines.append("")
        else:
            lines.append("" if fence else line)
    return lines


def locator(path, lines, start, end):
    return {"path": path, "lineStart": start + 1, "lineEnd": end,
            "excerpt": "\n".join(lines[start:end]).strip(), "anchor": f"L{start + 1}"}


def split_fields(lines, pattern, where):
    fields = {}
    positions = [(i, match) for i, line in enumerate(structural_lines("\n".join(lines)))
                 if (match := re.match(pattern, line))]
    for n, (i, match) in enumerate(positions):
        key = match[1]
        require(key not in fields, f"{where}: duplicate {key}")
        end = positions[n + 1][0] if n + 1 < len(positions) else len(lines)
        fields[key] = "\n".join([match[2], *[s.strip() for s in lines[i + 1:end]]]).strip()
    return fields


def field(fields, key, where):
    value = fields.get(key, "").strip()
    require(bool(value), f"{where}: missing {key}")
    require("{{" not in value and "<replace" not in value.lower(), f"{where}: unfilled {key}")
    return value


def dependencies(value, where):
    if value.lower() == "none":
        return []
    items = [s.strip().strip("`") for s in value.split(",")]
    require(all(items) and len(items) == len(set(items)), f"{where}: invalid/duplicate dependencies")
    return items


def ancestors(items, label):
    index = {item["id"]: item for item in items}
    require(len(index) == len(items), f"Duplicate {label} IDs")
    result, visiting = {}, set()

    def visit(key):
        require(key in index, f"Unknown {label} dependency: {key}")
        require(key not in visiting, f"Cycle in {label} dependencies at {key}")
        if key in result:
            return result[key]
        visiting.add(key)
        found = set()
        for dep in index[key]["dependsOn"]:
            found.add(dep)
            found.update(visit(dep))
        visiting.remove(key)
        result[key] = found
        return found

    for key in index:
        visit(key)
    return result


def parse_specs(sources):
    capabilities, requirements, scenarios = [], [], []
    for path, text in sorted(sources.items()):
        if not path.startswith("specs/") or not path.endswith(".md"):
            continue
        cap_id = Path(path).parent.relative_to("specs").as_posix()
        require(cap_id != ".", f"{path}: place the spec in a capability folder")
        require(not any(c["id"] == cap_id for c in capabilities), f"Duplicate capability folder: {cap_id}")
        lines, structure = text.splitlines(), structural_lines(text)
        for i, line in enumerate(structure):
            apparent = re.match(r"^\s*#{1,6}\s*(Requirement|Scenario)\b", line, re.I)
            if apparent:
                expected = "### Requirement:" if apparent[1].lower() == "requirement" else "#### Scenario:"
                require(bool(re.match(r"^" + re.escape(expected) + r"\s+\S", line)),
                        f"{path}:{i + 1}: malformed heading; use '{expected} Title'")
        sections = [(i, m[1]) for i, line in enumerate(structure)
                    if (m := re.match(r"^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$", line))]
        require(bool(sections), f"{path}: no native delta sections")
        cap_reqs, renames, seen = [], [], set()
        for n, (start, operation) in enumerate(sections):
            end = sections[n + 1][0] if n + 1 < len(sections) else len(lines)
            # Any other H2 ends this delta section too.
            end = next((i for i in range(start + 1, end) if structure[i].startswith("## ")), end)
            if operation == "RENAMED":
                targets = re.findall(r"(?m)^\s*-\s*TO:\s*`?### Requirement:\s*(.*?)`?\s*$", "\n".join(structure[start:end]))
                require(bool(targets), f"{path}: invalid RENAMED section; use native FROM:/TO: pairs")
                renames.extend(t.rstrip("`") for t in targets)
                continue
            heads = [(i, m[1]) for i in range(start + 1, end)
                     if (m := re.match(r"^### Requirement:\s*(.+?)\s*$", structure[i]))]
            for k, (req_start, title) in enumerate(heads):
                req_end = heads[k + 1][0] if k + 1 < len(heads) else end
                require(title not in seen, f"{path}: duplicate requirement {title!r}")
                seen.add(title)
                req_id = f"{cap_id}:r{len(cap_reqs) + 1:02d}"
                scn_heads = [(i, m[1]) for i in range(req_start + 1, req_end)
                             if (m := re.match(r"^#### Scenario:\s*(.+?)\s*$", structure[i]))]
                body_end = scn_heads[0][0] if scn_heads else req_end
                short_lines = [(i, m[1]) for i in range(req_start + 1, body_end)
                               if (m := re.match(r"^\*\*Short title:\*\*\s*(.+?)\s*$", structure[i]))]
                require(len(short_lines) == 1, f"{path}:{req_start + 1}: require one authored Short title")
                short_line, short_title = short_lines[0]
                require(len(short_title.split()) == 3, f"{path}:{short_line + 1}: Short title must have exactly three words")
                body = "\n".join(lines[i] for i in range(req_start + 1, body_end) if i != short_line).strip()
                require(bool(body), f"{path}: {title}: empty requirement")
                if operation == "REMOVED":
                    require("**Reason**" in body or "**Reason:" in body, f"{path}: removed requirement needs Reason")
                    require("**Migration**" in body or "**Migration:" in body, f"{path}: removed requirement needs Migration")
                else:
                    require(bool(scn_heads), f"{path}: {title}: needs at least one scenario")
                scn_ids = []
                for j, (scn_start, scn_title) in enumerate(scn_heads):
                    scn_end = scn_heads[j + 1][0] if j + 1 < len(scn_heads) else req_end
                    scn_id = f"{req_id}:s{j + 1:02d}"
                    scn_body = "\n".join(lines[scn_start + 1:scn_end]).strip()
                    require(bool(scn_body), f"{path}: empty scenario {scn_title!r}")
                    scenarios.append({"id": scn_id, "requirementId": req_id, "title": scn_title,
                                      "body": scn_body, "source": locator(path, lines, scn_start, scn_end)})
                    scn_ids.append(scn_id)
                requirements.append({"id": req_id, "capabilityId": cap_id, "title": title,
                                     "shortTitle": short_title, "deltaType": operation, "body": body,
                                     "scenarioIds": scn_ids, "source": locator(path, lines, req_start, req_end)})
                cap_reqs.append(req_id)
        for target in renames:
            require(any(r["capabilityId"] == cap_id and r["title"] == target and r["deltaType"] == "MODIFIED"
                        for r in requirements), f"{path}: RENAMED target {target!r} needs its full MODIFIED requirement for review")
        require(bool(cap_reqs), f"{path}: no requirements to display")
        capabilities.append({"id": cap_id, "requirementIds": cap_reqs, "source": locator(path, lines, 0, len(lines))})
    require(bool(capabilities), "No capability specs found")
    return capabilities, requirements, scenarios


def parse_tasks(text):
    path = "tasks.md"
    lines, structure = text.splitlines(), structural_lines(text)
    checkbox_lines = [line for line in structure if re.match(r"^\s*(?:[-*+]|\d+[.)])\s*\[[ xX]*\]", line)]
    require(all(re.match(r"^- \[[ xX]\] \d+\.\d+\s+\S", line) for line in checkbox_lines),
            "tasks.md: every checkbox must use '- [ ] X.Y Title' under an M phase")
    heads = [(i, m[1], m[2]) for i, line in enumerate(structure)
             if (m := re.match(r"^## (M\d+):\s*(.+?)\s*$", line))]
    require(bool(heads), "tasks.md: use ## M0: Title phase headings")
    phases, tasks = [], []
    for n, (start, phase_id, title) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        task_heads = [(i, m[1], m[2], m[3]) for i in range(start + 1, end)
                      if (m := re.match(r"^- \[([ xX])\] (\d+\.\d+)\s+(.+?)\s*$", structure[i]))]
        require(bool(task_heads), f"tasks.md: {phase_id}: phase needs tasks")
        attrs = split_fields(lines[start + 1:task_heads[0][0]], r"^\*\*([^*]+):\*\*\s*(.*)$", phase_id)
        phase = {"id": phase_id, "title": title,
                 "dependsOn": dependencies(field(attrs, "Depends on", phase_id), phase_id),
                 "outcome": field(attrs, "Outcome", phase_id), "taskIds": [],
                 "source": locator(path, lines, start, end)}
        phases.append(phase)
        for k, (task_start, checked, task_id, task_title) in enumerate(task_heads):
            require(task_id.split(".")[0] == phase_id[1:], f"tasks.md: {task_id}: task ID prefix must match {phase_id}")
            task_end = task_heads[k + 1][0] if k + 1 < len(task_heads) else end
            attrs = split_fields(lines[task_start + 1:task_end], r"^\s{2,}- ([A-Za-z ]+):\s*(.*)$", task_id)
            task_type = field(attrs, "Type", task_id)
            require(task_type in TYPES, f"tasks.md: {task_id}: Type must be one of {', '.join(TYPES)}")
            owners = [s.strip() for s in field(attrs, "Owner", task_id).split("+")]
            require(all(owners), f"tasks.md: {task_id}: empty owner")
            tasks.append({"id": task_id, "phaseId": phase_id, "title": task_title, "type": task_type,
                          "owners": owners, "dependsOn": dependencies(field(attrs, "Depends on", task_id), task_id),
                          "body": field(attrs, "Details", task_id), "acceptance": field(attrs, "Acceptance", task_id),
                          "done": checked.lower() == "x", "source": locator(path, lines, task_start, task_end)})
            phase["taskIds"].append(task_id)
    require(len(checkbox_lines) == len(tasks), "tasks.md: every checkbox must use '- [ ] X.Y Title' under an M phase")
    ancestors(tasks, "task")
    phase_ancestors = ancestors(phases, "phase")
    task_index = {t["id"]: t for t in tasks}
    aggregate = {p["id"]: set() for p in phases}
    for task in tasks:
        for dep in task["dependsOn"]:
            dep_phase = task_index[dep]["phaseId"]
            if dep_phase != task["phaseId"]:
                aggregate[task["phaseId"]].add(dep_phase)
    task_phase_ancestors = ancestors([{"id": k, "dependsOn": sorted(v)} for k, v in aggregate.items()], "task phase")
    for phase in phases:
        key = phase["id"]
        require(phase_ancestors[key] == task_phase_ancestors[key],
                f"tasks.md: {key}: phase dependencies must summarize authored cross-phase task dependencies")
    return phases, tasks


def parse_decisions(text):
    lines, structure = text.splitlines(), structural_lines(text)
    starts = [i for i, s in enumerate(structure) if s == "## Review decisions"]
    require(len(starts) == 1, "design.md: require one '## Review decisions' section")
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines)) if structure[i].startswith("## ")), len(lines))
    heads = [(i, m[1], m[2]) for i in range(start + 1, end)
             if (m := re.match(r"^### (D\d+):\s*(.+?)\s*$", structure[i]))]
    require(bool(heads), "design.md: Review decisions needs explicit ### D1: Title cards")
    decisions = []
    for n, (begin, decision_id, title) in enumerate(heads):
        finish = heads[n + 1][0] if n + 1 < len(heads) else end
        attrs = split_fields(lines[begin + 1:finish], r"^\*\*([^*]+):\*\*\s*(.*)$", decision_id)
        def bullets(key):
            value = field(attrs, key, decision_id)
            result = re.split(r"(?m)^-\s+", value)
            require(len(result) > 1 and not result[0].strip(), f"design.md: {decision_id}: {key} needs bullets")
            return [item.strip() for item in result[1:] if item.strip()]
        decisions.append({"id": decision_id, "title": title, "context": field(attrs, "Context", decision_id),
                          "proposedOption": field(attrs, "Proposed option", decision_id), "pros": bullets("Pros"),
                          "cons": bullets("Cons"), "decisionNeeded": field(attrs, "Decision needed", decision_id),
                          "source": locator("design.md", lines, begin, finish)})
    require(len({d["id"] for d in decisions}) == len(decisions), "design.md: duplicate review decision IDs")
    return decisions


def git_output(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def build_data(change: Path, schema: Path):
    change, schema = change.resolve(), schema.resolve()
    require(change.is_dir(), f"Change directory not found: {change}")
    paths = [change / name for name in ("research.md", "proposal.md", "design.md", "tasks.md")]
    paths += sorted((change / "specs").rglob("*.md"))
    paths += [schema / "schema.yaml", schema / "tools" / "render_review.py"]
    paths += sorted(path for path in (schema / "templates").glob("*") if path.is_file())
    # OpenSpec configuration and selected-schema metadata influence authoring
    # instructions even when the canonical Markdown has not changed.
    configuration_paths = [change.parent.parent / "config.yaml", change / ".openspec.yaml"]
    paths += [path for path in configuration_paths if path.is_file()]
    sources = []
    for path in paths:
        require(not path.is_symlink() and not any(parent.is_symlink() for parent in path.parents), f"Symlink input is not allowed: {path}")
        require(path.is_file(), f"Missing input: {path}")
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        sources.append({"path": Path(os.path.relpath(path, change)).as_posix(),
                        "sha256": hashlib.sha256(raw).hexdigest(), "text": text,
                        "lineCount": len(text.splitlines())})
    sources.sort(key=lambda s: s["path"])
    manifest = [{"path": s["path"], "sha256": s["sha256"]} for s in sources]
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
    by_path = {s["path"]: s["text"] for s in sources}
    capabilities, requirements, scenarios = parse_specs(by_path)
    phases, tasks = parse_tasks(by_path["tasks.md"])
    decisions = parse_decisions(by_path["design.md"])
    version = re.findall(r"(?m)^\*\*Spec version:\*\*\s*(\S[^\n]*)$", by_path["proposal.md"])
    require(len(version) == 1 and re.fullmatch(r"[1-9]\d*", version[0].strip()),
            "proposal.md: require one explicit **Spec version:** positive integer")
    title = re.search(r"(?m)^# (.+)$", by_path["proposal.md"])
    repo = git_output(change, "rev-parse", "--show-toplevel")
    sha, branch, dirty = None, None, False
    if repo:
        # Deleted inputs must still identify their deletion commit. Existing
        # filenames alone miss removal of a capability or optional template.
        tracked_paths = sorted({os.path.relpath(path, repo) for path in paths + configuration_paths})
        tracked_paths += [f":(glob){os.path.relpath(change / 'specs', repo)}/**/*.md",
                          f":(glob){os.path.relpath(schema / 'templates', repo)}/*"]
        sha = git_output(Path(repo), "log", "-1", "--format=%H", "--", *tracked_paths) or None
        branch = git_output(Path(repo), "symbolic-ref", "--short", "-q", "HEAD") or "detached"
        dirty = bool(git_output(Path(repo), "status", "--porcelain", "--untracked-files=all", "--", *tracked_paths))
    delta_counts = Counter(r["deltaType"] for r in requirements)
    return {"templateVersion": VERSION, "changeId": change.name, "title": title[1] if title else change.name,
            "metadata": {"sha": sha, "shaDirty": dirty, "specVersion": version[0].strip(), "branch": branch,
                         "sourceDigest": digest},
            "counts": {"specifications": len(capabilities), "requirements": len(requirements), "scenarios": len(scenarios),
                       "tasks": len(tasks), "tasksDone": sum(t["done"] for t in tasks),
                       "addedRequirements": delta_counts["ADDED"], "modifiedRequirements": delta_counts["MODIFIED"],
                       "removedRequirements": delta_counts["REMOVED"]},
            "capabilities": capabilities, "requirements": requirements, "scenarios": scenarios, "phases": phases,
            "tasks": tasks, "decisions": decisions, "sources": sources, "sourceDigest": digest}


def render_html(template, data):
    payload = json.dumps(data, ensure_ascii=True, separators=(",", ":"))
    for char in "<>&":
        payload = payload.replace(char, f"\\u{ord(char):04x}")
    require(len(DATA_SCRIPT.findall(template)) == 1, "HTML template must contain exactly one review-data script")
    return DATA_SCRIPT.sub(lambda m: m[1] + payload + m[3], template)


def validate_native(change, data):
    repo = change.parent.parent.parent
    require(change.parent.name == "changes" and change.parent.parent.name == "openspec",
            "Place the change under <repo>/openspec/changes/<change-id> for native CLI validation")
    commands = [["openspec", "validate", change.name, "--strict"],
                ["openspec", "instructions", "elaboration-review-deck", "--change", change.name, "--json"],
                ["openspec", "show", change.name, "--json"]]
    results = []
    for command in commands:
        try:
            result = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=60)
        except FileNotFoundError as exc:
            raise SourceError("Install the OpenSpec CLI before generating the review deck") from exc
        require(result.returncode == 0, f"{' '.join(command)} failed:\n{result.stderr}\n{result.stdout}")
        results.append(result.stdout)
    instructions, native = json.loads(results[1]), json.loads(results[2])
    require(instructions.get("artifactId") == "elaboration-review-deck", "OpenSpec resolved an unexpected artifact")
    required = {"research", "elaboration-proposal", "elaboration-specs", "elaboration-design", "elaboration-tasks"}
    deps = instructions.get("dependencies", [])
    require({d["id"] for d in deps} == required, "Review artifact must expose all five source dependencies")
    require(all(d.get("done") for d in deps), "OpenSpec reports an incomplete source artifact")
    our_counts = Counter((r["capabilityId"], r["deltaType"]) for r in data["requirements"])
    native_counts = Counter((d["spec"], d["operation"]) for d in native["deltas"] if d["operation"] != "RENAMED")
    require(our_counts == native_counts, f"Requirement inventory differs from OpenSpec: {our_counts} != {native_counts}")
    ours_scenarios = Counter()
    native_scenarios = Counter()
    for req in data["requirements"]:
        ours_scenarios[(req["capabilityId"], req["deltaType"])] += len(req["scenarioIds"])
    for delta in native["deltas"]:
        if delta["operation"] != "RENAMED":
            native_scenarios[(delta["spec"], delta["operation"])] += len((delta.get("requirement") or {}).get("scenarios", []))
    require(ours_scenarios == native_scenarios, "Scenario inventory differs from OpenSpec")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--change", required=True, help="Change ID or path under openspec/changes")
    parser.add_argument("--output", type=Path, help="Defaults to CHANGE/review-deck.html; copied outputs retain source-relative links")
    parser.add_argument("--json-output", type=Path, help="Optional readable data snapshot")
    parser.add_argument("--check", action="store_true", help="Validate sources and compare output without writing")
    args = parser.parse_args(argv)
    schema = Path(__file__).resolve().parent.parent
    change = Path(args.change)
    if not change.is_dir():
        change = Path.cwd() / "openspec" / "changes" / args.change
    change = change.resolve()
    try:
        data = build_data(change, schema)
        validate_native(change, data)
        html = render_html((schema / "templates" / "review-deck.html").read_text(), data)
        output = args.output or change / "review-deck.html"
        # Never overwrite an input through a custom output argument or symlink.
        inputs = {(change / s["path"]).resolve() for s in data["sources"]}
        require(output.resolve() not in inputs, "Output path would overwrite a source input")
        if args.json_output:
            require(args.json_output.resolve() not in inputs and args.json_output.resolve() != output.resolve(),
                    "JSON output path must be separate from HTML and source inputs")
        pretty = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        if args.check:
            require(output.is_file() and output.read_text() == html, f"Stale or missing deck: {output}; regenerate it")
            if args.json_output:
                require(args.json_output.is_file() and args.json_output.read_text() == pretty, "Stale or missing JSON snapshot")
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(html)
            if args.json_output:
                args.json_output.parent.mkdir(parents=True, exist_ok=True)
                args.json_output.write_text(pretty)
        print(json.dumps({"action": "verified" if args.check else "rendered", "output": str(output),
                          "counts": data["counts"], "phases": len(data["phases"]), "decisions": len(data["decisions"]),
                          "sourceDigest": data["sourceDigest"]}, indent=2))
        return 0
    except (SourceError, OSError, UnicodeError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f"Review deck: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
