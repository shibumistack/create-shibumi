// Test harness: starts an atomic create whose install step hangs forever,
// so the parent test can deliver SIGINT mid-scaffold.
import { createProject } from "../../src/create";

const [parentDir, templatesDir] = process.argv.slice(2);

await createProject(
  {
    name: "sig-app",
    parentDir: parentDir!,
    template: "static",
    git: false,
    install: true,
    templatesDir: templatesDir!,
  },
  async () => {
    console.log("HANGING");
    await new Promise(() => {});
    return { ok: true, code: 0 };
  }
);
