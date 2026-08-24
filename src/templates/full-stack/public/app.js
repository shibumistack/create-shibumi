// Alpine behavior lives here. The vendored build is the CSP-safe variant:
// register components with Alpine.data() and reference methods by name in
// markup; inline expressions are not evaluated.
document.addEventListener("alpine:init", () => {
  Alpine.data("counter", () => ({
    count: 0,
    async init() {
      const res = await fetch("/api/counter");
      if (res.ok) this.count = (await res.json()).count;
    },
    async inc() {
      const res = await fetch("/api/counter", { method: "POST" });
      if (res.ok) this.count = (await res.json()).count;
    },
  }));
});
