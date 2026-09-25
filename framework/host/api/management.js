// host/api/management.js — chrome.management backend (runs in the Node host).
//
// The chrome.* shim in each content world marshals calls to the host via the
// Runtime.addBinding bridge; the host dispatches by (api, method) to these
// backend modules. This file implements the `management` namespace against the
// host's in-memory ExtensionRegistry (the same registry the loader/target-manager
// uses).

export const management = {
  async getAll(_ctx, _args) {
    return Array.from(registry()).map(info);
  },
  async get(_ctx, [id]) {
    const e = registry().get(id); return e ? info(e) : undefined;
  },
  async getSelf(ctx) {
    return info(registry().get(ctx.extensionId));
  },
  async setEnabled(_ctx, [id, enabled]) {
    const e = registry().get(id); if (!e) throw new Error("no such extension");
    e.enabled = enabled;
    if (enabled) host.injectExtension(e); else host.stripExtension(e);
    bus.emit("management.onEnabled", { id, enabled });
    return;
  },
  async uninstall(_ctx, [id]) {
    host.stripExtension(registry().get(id));
    registry().delete(id);
    bus.emit("management.onUninstalled", { id });
  },
  async loadUnpacked(_ctx, [path]) {
    // path may be undefined if invoked from the panel's folder picker; the host
    // resolves it via Page.setInterceptFileChooserDialog before calling this.
    const e = await host.loadExtension(path);
    bus.emit("management.onInstalled", { id: e.id });
    return e.id;
  },
  async reload(_ctx, [id]) {
    const e = registry().get(id);
    host.stripExtension(e);
    await host.injectExtension(e); // same path as the fs.watch hot-reload loop
  },
  getPermissionWarnings(_ctx, [id]) {
    const e = registry().get(id); return e ? e.permissionWarnings : [];
  },
};

function info(e) {
  return {
    id: e.id, name: e.name, version: e.version, description: e.description,
    enabled: e.enabled, installType: e.builtin ? "admin" : "development",
    type: "extension", manifest: e.manifest,
    permissions: e.manifest.permissions || [],
    hostPermissions: e.manifest.host_permissions || [],
    icons: e.manifest.icons || {},
    mayDisable: !e.builtin,
    permissionWarnings: e.permissionWarnings || [],
  };
}

// `registry` and `host` are injected by the host process at startup; this file is
// a spec/skeleton, so they're referenced as globals here.
/* global registry, host, bus */
