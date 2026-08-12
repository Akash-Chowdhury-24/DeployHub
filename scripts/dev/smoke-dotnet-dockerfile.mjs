import { smokeDockerfile, fs, path } from './lib/smoke-docker.mjs';

await smokeDockerfile({
  framework: 'dotnet',
  port: 5000,
  hostPort: 15000,
  expectBody: 'ok-dotnet',
  config: {
    buildCommand: 'dotnet publish -c Release -o publish',
    buildOutput: 'publish',
  },
  readinessMs: 4000,
  setup: async (tmp) => {
    await fs.writeFile(
      path.join(tmp, 'App.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>App</AssemblyName>
  </PropertyGroup>
</Project>
`
    );
    await fs.writeFile(
      path.join(tmp, 'Program.cs'),
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/", () => "ok-dotnet");
app.Run();
`
    );
  },
});
