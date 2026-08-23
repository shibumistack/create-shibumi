// Alpine behavior lives here. The vendored build is the CSP-safe variant:
// register components with Alpine.data() and reference methods by name in
// markup; inline expressions are not evaluated.
document.addEventListener("alpine:init", () => {
  Alpine.data("counter", () => ({
    count: 0,
    inc() {
      this.count++;
    },
  }));
});
