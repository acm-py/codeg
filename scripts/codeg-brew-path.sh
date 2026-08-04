# Restore the host-mounted Homebrew path after Debian's /etc/profile resets
# PATH for root login shells.
codeg_brew_home="${CODEG_HOST_BREW_HOME:-/home/linuxbrew/.linuxbrew}"
if [ -d "$codeg_brew_home/bin" ]; then
    PATH="$codeg_brew_home/bin:$codeg_brew_home/sbin:$PATH"
    export PATH
fi
unset codeg_brew_home
