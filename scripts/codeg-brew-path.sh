# Restore the host-mounted Homebrew path after Debian's /etc/profile resets
# PATH for root login shells.
codeg_brew_home="${CODEG_HOST_BREW_HOME:-/home/linuxbrew/.linuxbrew}"
if [ -d "$codeg_brew_home/bin" ]; then
    PATH="$codeg_brew_home/bin:$codeg_brew_home/sbin:$PATH"
    export PATH
fi

# Keep an explicitly configured Notebook environment ahead of Homebrew after
# Debian's login profile and the host Brew path have both run.
codeg_jupyter_venv_bin="${CODEG_JUPYTER_VENV_BIN:-}"
if [ -x "$codeg_jupyter_venv_bin/python3" ]; then
    PATH="$codeg_jupyter_venv_bin:$PATH"
    export PATH
fi
unset codeg_brew_home codeg_jupyter_venv_bin
