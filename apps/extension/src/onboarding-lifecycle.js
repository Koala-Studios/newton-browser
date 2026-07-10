export function openOnFirstInstall(details, openSetup) {
  if (details?.reason !== "install") return false;
  void Promise.resolve(openSetup()).catch(() => {});
  return true;
}
