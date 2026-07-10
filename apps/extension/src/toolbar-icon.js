const CONNECTED_ICON = {
  16: "icons/action-connected-16.png",
  32: "icons/action-connected-32.png",
};
const DISCONNECTED_ICON = {
  16: "icons/action-disconnected-16.png",
  32: "icons/action-disconnected-32.png",
};

export function createToolbarIconController({ action, getConnected, delayMs = 125, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let applied;
  let pending;

  function schedule() {
    const desired = Boolean(getConnected());
    if (pending) clearTimer(pending);
    if (desired === applied) return;
    pending = setTimer(() => {
      pending = null;
      const current = Boolean(getConnected());
      if (current === applied) return;
      applied = current;
      void action.setIcon({ path: current ? CONNECTED_ICON : DISCONNECTED_ICON }).catch(() => {});
    }, delayMs);
  }

  return { schedule };
}
