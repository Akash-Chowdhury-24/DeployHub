import { smokeDockerfile, fs, path } from './lib/smoke-docker.mjs';

await smokeDockerfile({
  framework: 'go',
  port: 8080,
  hostPort: 18082,
  expectBody: 'ok-go',
  config: {
    buildCommand: 'go build -o /app/bin/app .',
  },
  setup: async (tmp) => {
    await fs.writeFile(
      path.join(tmp, 'go.mod'),
      'module deployhub.local/smoke\n\ngo 1.22\n'
    );
    await fs.writeFile(
      path.join(tmp, 'main.go'),
      `package main
import (
  "fmt"
  "net/http"
)
func main() {
  http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprint(w, "ok-go")
  })
  http.ListenAndServe(":8080", nil)
}
`
    );
  },
});
