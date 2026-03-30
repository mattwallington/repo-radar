"""Terminal color codes and display constants."""

GREEN = "\033[92m"
BLUE = "\033[94m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Color palette for repo IDs (pleasant terminal colors)
REPO_COLORS = [
    "\033[96m",   # Cyan
    "\033[92m",   # Green
    "\033[95m",   # Magenta
    "\033[93m",   # Yellow
    "\033[94m",   # Blue
    "\033[91m",   # Red
    "\033[97m",   # White
    "\033[35m",   # Purple
    "\033[36m",   # Cyan (alt)
    "\033[32m",   # Green (alt)
]

# Rich progress bar colors (distinct, non-adjacent similar colors)
# These are distributed across the color spectrum to maximize visual distinction
PROGRESS_COLORS = [
    "cyan",        # 0: Cyan
    "red",         # 1: Red (opposite side)
    "green",       # 2: Green
    "magenta",     # 3: Magenta
    "yellow",      # 4: Yellow
    "blue",        # 5: Blue
    "bright_cyan", # 6: Bright Cyan
    "bright_red",  # 7: Bright Red
    "bright_green",# 8: Bright Green
    "bright_magenta", # 9: Bright Magenta
    "bright_yellow",  # 10: Bright Yellow
    "bright_blue",    # 11: Bright Blue
    "dark_cyan",      # 12: Dark Cyan
    "dark_orange",    # 13: Dark Orange
    "purple",         # 14: Purple
    "deep_pink4",     # 15: Deep Pink
    "dodger_blue2",   # 16: Dodger Blue
    "spring_green3",  # 17: Spring Green
    "orange1",        # 18: Orange
    "hot_pink",       # 19: Hot Pink
]
