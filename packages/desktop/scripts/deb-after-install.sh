#!/bin/bash
# deb 安装后的收尾钩子（issue #151 缺陷二）。
#
# ## 为什么需要它
#
# electron-builder 生成的默认 `postinst` 用「root 能不能建用户命名空间」来判
# `chrome-sandbox` 该给 4755 还是 0755：
#
# ```sh
# if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
#     chmod 4755 '/opt/Corum/chrome-sandbox' || true
# else
#     chmod 0755 '/opt/Corum/chrome-sandbox' || true
# fi
# ```
#
# 而 `postinst` **以 root 运行**，root 在任何内核策略下都能建用户命名空间 ⇒ 判据恒真 ⇒
# 永远落到 0755。但 Ubuntu 23.10+ 默认 `kernel.apparmor_restrict_unprivileged_userns=1`，
# 该策略下**普通用户**进程用不了 namespace 沙箱，Electron 必须依赖 setuid 的
# `chrome-sandbox`。判据问的是 root 能不能，实际需求是普通用户能不能 —— 两者脱节。
#
# 结果：每次 `dpkg -i` 都把 4755 打回 0755，应用启动即退（无窗口、无报错）。
#
# ## 为什么按内核策略判、而不是无条件 4755
#
# 无条件 4755 会在「用户命名空间正常工作」的发行版上白白引入一个 setuid 二进制。
# 这里按**普通用户视角**的真实生效策略判：命中任一条「需要 setuid」的迹象才 4755。
#
# 钩子以 root 运行；任何一步失败都不要让安装失败（`|| true`），权限修不好至少能装完升级。

set -u

SANDBOX=/opt/Corum/chrome-sandbox
[ -e "$SANDBOX" ] || exit 0

need_suid=0

# Ubuntu 23.10+ 默认开启：非特权进程不允许 apparmor 未豁免的用户命名空间。
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  need_suid=1
fi

# Debian/Ubuntu 老内核的等效开关：显式关掉非特权用户命名空间时同样需要 setuid。
if [ "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ]; then
  need_suid=1
fi

if [ "$need_suid" = "1" ]; then
  chmod 4755 "$SANDBOX" || true
else
  chmod 0755 "$SANDBOX" || true
fi

exit 0