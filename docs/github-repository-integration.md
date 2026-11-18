# Public GitHub repository integration

Add a public GitHub repository URL to a DockerPilot project. Saving the project connects it; clearing the URL disconnects it. Project settings contain the project name, GitHub repository, and optional description. No GitHub token or local repository path is required.

Git Detective uses the URL to read repository metadata, the default branch, and up to eight recent commits directly from GitHub's public API. It retrieves bounded diffs for up to five commits and excludes `.env` and known credential files. History is cached for ten minutes per project. Open **Intelligence → Git Detective** and choose a project to analyze it. When a Stack Doctor scan exists, its findings provide context for Git Detective. GitHub API limits and outages are reported in the Intelligence section while Docker diagnosis continues.

Private repositories are not supported. Git Detective only uses the saved public GitHub repository URL; it does not inspect folders on the DockerPilot computer or paired agent.

Commit ranking is heuristic and indicates possible relationships only. It does not prove that a commit caused a Docker issue. AI explanations are optional; Docker-based findings remain available when an AI provider or GitHub is unavailable.
