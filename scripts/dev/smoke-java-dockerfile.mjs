import { smokeDockerfile, fs, path } from './lib/smoke-docker.mjs';

await smokeDockerfile({
  framework: 'spring',
  port: 8080,
  hostPort: 18088,
  expectBody: 'ok-spring',
  config: {
    buildCommand: 'mvn -q -DskipTests package',
  },
  readinessMs: 8000,
  setup: async (tmp) => {
    await fs.writeFile(
      path.join(tmp, 'pom.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
  </parent>
  <groupId>deployhub.local</groupId>
  <artifactId>smoke</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <properties>
    <java.version>17</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`
    );
    await fs.ensureDir(path.join(tmp, 'src/main/java/com/example'));
    await fs.writeFile(
      path.join(tmp, 'src/main/java/com/example/App.java'),
      `package com.example;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class App {
  public static void main(String[] args) {
    SpringApplication.run(App.class, args);
  }
  @GetMapping("/")
  public String home() { return "ok-spring"; }
}
`
    );
  },
});
