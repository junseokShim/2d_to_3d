# Free MCP servers for Tool3D — report (worker-mcp, 2026-09-28)

MCP = Model Context Protocol: a plug-in that gives the AI assistant (Claude Code) extra tools.
It helps the *developer's assistant*, not the shipped app/APK. Nothing here runs inside Tool3D at runtime.

## Bottom line
No free MCP makes the output "scanner-grade" in the metrology sense. VB (flank wear length, mm) and
wear volume (mm³) accuracy is set by the photos (resolution, px/mm scale from the known Ø, lighting,
focus) and our measurement code — not by a renderer or an AI mesh generator. MCPs below improve
**visuals** or **developer workflow**. Image-to-3D AI models actively **hurt** metrology (they invent geometry).

## Checked on this PC
- GPU: NVIDIA RTX 3060, 8 GB. Python 3.14.4 present.
- Not installed: Blender, uv/uvx, Node.js/npx. No `.mcp.json` in the repo.
- Claude Code here already lists a claude.ai **Hugging Face** connector (not yet authenticated).

## Top 3

| # | Server | Cost | Local? | Helps metrology? | Helps visuals? |
|---|---|---|---|---|---|
| 1 | Blender MCP (github.com/ahujasid/blender-mcp) | Free, MIT | Yes (Blender on this PC) | Partly — can compute mesh volume of a modeled wear solid; no accuracy gain over our own math | Yes — Cycles photoreal renders, HDRI, turntables, GLB export |
| 2 | Hugging Face MCP (huggingface.co/mcp) + Spaces (e.g. microsoft/TRELLIS, tencent/Hunyuan3D-2) | Free account; GPU Spaces use a small daily ZeroGPU quota (PRO raises it) | No (cloud) | **No.** Output is unscaled, hallucinated geometry; fine flank-land detail is invented | Quick "look" mockups only |
| 3 | MeshLab MCP (github.com/Georges999/MeshLab-mcp, pymeshlab) | Free | Yes | Mesh cleanup, watertight check, volume/area — only on a mesh we already have | No |

### 1. Blender MCP
- **Install (needs human OK, not done):**
  1. Install Blender 4.x (blender.org, free).
  2. Install uv: `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`.
  3. Install the add-on (README: `uvx mcp-for-blender install-addon`, or download `addon.py` from the repo), enable it in Blender › Preferences › Add-ons, click "Connect" (port 9876).
  4. Add the `.mcp.json` entry below; restart Claude Code.
- **Improves:** product-shot renders of the parametric end mill with wear painted red; exporting GLB for the three.js viewer; batch renders for the README/report.
- **Risks:** it runs **arbitrary Python inside Blender** (can touch files) — use only on a trusted machine; the add-on's optional features (Hyper3D Rodin, Sketchfab, Hunyuan3D) send data to third parties and some need keys — leave them off; telemetry is opt-in, force off with `DISABLE_TELEMETRY=true`; package name changed in the README (`mcp-for-blender`, earlier `blender-mcp`) — pin the version at install time.

### 2. Hugging Face MCP + 3D Spaces
- **Install:** no software. Human logs in at huggingface.co/settings/mcp, copies the Claude Code snippet (or authenticates the existing claude.ai HF connector), and adds TRELLIS/Hunyuan3D Spaces.
- **Improves:** fast AI mesh from one photo, for a demo look.
- **Risks:** needs an HF account (human decision); photos are uploaded to public Spaces (customer/tool data leaves the PC); quota limits; results not reproducible; geometry not to scale → **must never feed VB/volume numbers.**

### 3. MeshLab MCP
- **Install:** `pip install pymeshlab` + clone the repo (small, community project — review code before running).
- **Improves:** mesh repair, watertight/volume checks if we ever export the model as STL/GLB.
- **Risks:** low-star community repo, little maintenance; duplicates what `trimesh`/our JS can do in 20 lines.

## Recommendation
1. **For accuracy, add no MCP.** Put effort into photo capture (fixed macro distance, diffuse ring light, scale from Ø or a reference gauge) and the wear module's calibration + honest error report (see board "Tool3D").
2. **For looks, optionally use Blender MCP** (free, local) as a *developer* tool to make reference renders and tune three.js PBR materials to match. The app itself keeps its bundled three.js renderer.
3. **Do not use image-to-3D (TRELLIS/Hunyuan3D) for measurements.** OK for a marketing mock-up only, and only with non-confidential photos.

## Draft `.mcp.json` (NOT installed — needs human approval to install Blender + uv)
```json
{
  "mcpServers": {
    "blender": {
      "command": "cmd",
      "args": ["/c", "uvx", "mcp-for-blender"],
      "env": {
        "DISABLE_TELEMETRY": "true",
        "BLENDER_HOST": "localhost",
        "BLENDER_PORT": "9876"
      }
    }
  }
}
```
Place at repo root only after approval. Pin a version (`mcp-for-blender==<x.y.z>`) once installed.

## Needs human approval
- Install Blender + uv on this PC (option 1).
- Create/authenticate a Hugging Face account and allow uploading tool photos to public Spaces (option 2).

Sources: github.com/ahujasid/blender-mcp (README), huggingface.co/docs/hub/hf-mcp-server,
github.com/Georges999/MeshLab-mcp.
