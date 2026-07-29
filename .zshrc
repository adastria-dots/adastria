# 1. ENVIRONMENT & PATH
export KEQING_DOTS_ROOT="$HOME/keqing-dots"
export -U PATH="$HOME/.local/bin:$PATH"

# 2. SHELL OPTIONS & HISTORY
export HISTFILE=~/.zsh_history
export HISTSIZE=10000
export SAVEHIST=10000
setopt appendhistory
typeset -g _hist_cmd=""
zshaddhistory() { return 1; }
preexec() { _hist_cmd="$1"; }
precmd() {
  local s=$?
  [[ $s -eq 0 && -n "$_hist_cmd" ]] && print -s -- "$_hist_cmd"
  _hist_cmd=""
}

# 3. AUTOCOMPLETION & PLUGINS
autoload -Uz compinit
compinit
zstyle ':completion:*' menu select
source /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh

# 4. CORE FUNCTIONS
fetch() { deps fastfetch && fastfetch; }
message() {
  printf '\e[38;2;155;87;244m'
  cat <<'EOF' | sed 's/^/      /'

    __ __                     _                  
   / //_/   ___     ____ _   (_)  ____     ____ _
  / ,<     / _ \   / __ `/  / /  / __ \   / __ `/
 / /| |   /  __/  / /_/ /  / /  / / / /  / /_/ /
/_/ |_|   \___/   \__, /  /_/  /_/ /_/   \__, /
                    /_/                 /____/
      
EOF
  printf '\e[0m'
}
greet() { [[ -z "$TERM_PROGRAM" && -z "$TERMINAL_EMULATOR" ]] && { message; fetch; }; }
clear() { command clear 2>/dev/null || printf '\033[H\033[2J\033[3J'; greet; }
_find() {
  deps fzf || return 1
  find "$HOME" -type d 2>/dev/null | awk -v s="/$1" 'substr($0,length($0)-length(s)+1)==s' | fzf --select-1 --exit-0 --layout=reverse
}
goto() {
  [[ -z "$1" ]] && { echo "Usage: goto <path-suffix>"; return 1; }
  local dir
  dir=$(_find "$1") && cd "$dir"
}
edit() {
  [[ -z "$1" ]] && { echo "Usage: edit <path-suffix>"; return 1; }
  deps code || return 1
  local dir
  dir=$(_find "$1") && code "$dir"
}

# 5. DEVELOPMENT TOOLS
clearpycache() { find . -type d -name "__pycache__" -exec rm -rf {} +; }
own() { sudo chown -R $USER $1; }
run() {
  local filename="$1" compiler="g++"
  [[ "$filename" == *.c ]] && compiler="gcc"
  $compiler "$filename" -o main && ./main
}

# 7. ALIASES
alias grep="grep --color=auto"
alias ls="ls --color=auto"
alias update="$KEQING_DOTS_ROOT/scripts/update"

# 8. EXTERNAL SOURCING
export CRYPTOGRAPHY_OPENSSL_NO_LEGACY=1
CONDA_SRC="/opt/miniconda3/etc/profile.d/conda.sh"
[ -f "$CONDA_SRC" ] && source "$CONDA_SRC"
for f in "$KEQING_DOTS_ROOT/source/"*.sh(N); do source "$f"; done

# 9. STARTUP EXECUTION
greet

# 10. EXTERNAL TOOL INITIALIZATION
deps starship && eval "$(starship init zsh)"
deps zoxide && eval "$(zoxide init zsh --cmd cd)"
