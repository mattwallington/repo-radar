"""Metadata parsing, response extraction, and index generation."""

import json
from datetime import datetime
from pathlib import Path

from repo_radar.config import PRISTINE_DIR, INDEX_FILE, load_cache_index
from repo_radar.constants import CYAN, GREEN, YELLOW, RESET


def extract_between(text, start_marker, end_marker):
    """Extract text between two markers."""
    start_idx = text.find(start_marker)
    if start_idx == -1:
        return ""

    start_idx += len(start_marker)
    end_idx = text.find(end_marker, start_idx)

    if end_idx == -1:
        return ""

    return text[start_idx:end_idx].strip()


def parse_llm_response(response_text):
    """Parse structured LLM response with delimiters."""
    # Extract quick reference
    quick_ref_raw = extract_between(response_text, 'QUICK_REFERENCE_START', 'QUICK_REFERENCE_END')

    # Parse quick reference into dict
    quick_ref = {}
    for line in quick_ref_raw.split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            quick_ref[key.strip().lower()] = value.strip()

    # Extract one-line summary
    brief = extract_between(response_text, 'ONE_LINE_SUMMARY_START', 'ONE_LINE_SUMMARY_END').strip()
    if not brief:
        brief = "Repository analysis"

    # Extract related repos
    related_text = extract_between(response_text, 'RELATED_REPOS_START', 'RELATED_REPOS_END')
    related_repos = [r.strip() for r in related_text.split(',') if r.strip()]

    # Get the main markdown (after the last marker)
    analysis_start = response_text.find('RELATED_REPOS_END')
    if analysis_start != -1:
        analysis_start += len('RELATED_REPOS_END')
        main_analysis = response_text[analysis_start:].strip()
    else:
        # Fallback - use entire response
        main_analysis = response_text

    return {
        'quick_ref': quick_ref,
        'brief': brief,
        'related_repos': related_repos,
        'analysis': main_analysis
    }


def regenerate_index(args):
    """Regenerate the master INDEX.md file from all metadata files."""
    if args.dry_run:
        print(f"  {CYAN}[DRY RUN]{RESET} Would regenerate INDEX.md")
        return

    print(f"  {CYAN}Regenerating{RESET} INDEX.md...")

    # Collect all metadata files (*.md files in pristine dir, excluding INDEX.md)
    metadata_files = [f for f in PRISTINE_DIR.glob('*.md') if f.name != 'INDEX.md']

    if not metadata_files:
        print(f"  {YELLOW}No metadata files found{RESET}")
        return

    # Parse metadata from each file
    repos_info = []
    for metadata_file in metadata_files:
        try:
            with open(metadata_file, 'r') as f:
                content = f.read()

                # Parse frontmatter
                if content.startswith('---'):
                    parts = content.split('---', 2)
                    if len(parts) >= 3:
                        frontmatter = parts[1]
                        info = {}
                        for line in frontmatter.split('\n'):
                            if ':' in line:
                                key, value = line.split(':', 1)
                                info[key.strip()] = value.strip()

                        repos_info.append({
                            'full_name': info.get('full_name', ''),
                            'cache_dir': info.get('cache_dir', ''),
                            'brief': info.get('brief', 'Repository analysis'),
                            'type': info.get('type', 'Unknown'),
                            'language': info.get('language', 'Unknown'),
                            'framework': info.get('framework', 'None'),
                            'database': info.get('database', 'None'),
                            'port': info.get('port', 'N/A'),
                            'apis': info.get('apis', 'None'),
                            'related_repos': info.get('related_repos', '[]'),
                            'metadata_file': metadata_file.name
                        })
        except Exception as e:
            print(f"  {YELLOW}Warning: Could not parse {metadata_file.name}:{RESET} {e}")
            continue

    # Sort by full name
    repos_info.sort(key=lambda x: x['full_name'])

    # Generate INDEX.md
    index_content = f"""# Pristine Repository Index

**Last Updated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
**Total Repositories:** {len(repos_info)}

> This index provides a quick overview of all cached repositories.
> Each entry links to detailed metadata for deeper analysis.

## Repositories

"""

    for info in repos_info:
        # Parse related repos
        try:
            related = json.loads(info['related_repos']) if info['related_repos'] != '[]' else []
        except:
            related = []
        related_str = ", ".join(related[:5]) if related else "None"

        # Build tech stack string
        tech_parts = []
        if info['language'] and info['language'] != 'Unknown':
            tech_parts.append(info['language'])
        if info['database'] and info['database'] != 'None':
            tech_parts.append(info['database'])
        if info['framework'] and info['framework'] != 'None':
            tech_parts.append(info['framework'])
        tech_str = ", ".join(tech_parts) if tech_parts else "Unknown"

        # Build APIs/exposes string
        apis_str = info.get('apis', 'None')
        if not apis_str or apis_str == 'None':
            apis_str = "N/A"

        index_content += f"""### {info['full_name']} (`{info['cache_dir']}/`)
**Type:** {info['type']}
**Tech:** {tech_str}
**Purpose:** {info['brief']}
**Exposes:** {apis_str}
**Database:** {info['database']}
**Interfaces:** {related_str}
**[View Details]({info['metadata_file']})**

---

"""

    # Write INDEX.md
    with open(INDEX_FILE, 'w') as f:
        f.write(index_content)

    print(f"  {GREEN}✓ INDEX.md updated{RESET} ({len(repos_info)} repositories)")
