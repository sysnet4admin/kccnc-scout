---
title: Deploy safety
description: Changes to deployment files keep the team cluster's contract and budget intact
type: check
when: "PRs that add or modify files under deploy/, argocd/ or .github/workflows/, or the Dockerfile"
actions: "Add the 'deploy-change' label. Comment with the result of each check below, and request changes if any check fails"
---

# Deploy safety

Merging to `main` deploys: the `build-and-deploy` workflow builds the image and commits
its tag, and Argo CD syncs `deploy/` into namespace `team-kccnc-scout`. The cluster is a
shared hackathon cluster with a fixed budget, so check these on every PR this rule matches:

1. Service `app` still exists in `deploy/`, listens on port 80, and its selector matches the
   app pods. The platform routes the public URL to exactly this Service.
2. No Service of type `LoadBalancer` or `NodePort`.
3. Every container sets CPU and memory requests and limits. All namespaces together must stay
   within 2 CPU and 4 GiB of requests, 4 CPU and 8 GiB of limits, 4 PVCs and 20 GiB of storage.
4. No privileged containers, no `hostPath` volumes, no `hostNetwork` and no `hostPID`.
   The host refuses such pods and they stay Pending.
5. `newName` and `newTag` under `images:` in `deploy/kustomization.yaml` are changed only by
   the workflow's `deploy: <sha> [skip ci]` commits, never by hand in a PR.
6. No secret values in manifests or workflows. Credentials come from Kubernetes Secrets
   created outside git and are referenced by name.
7. The liveness and readiness probes still point at `/healthz` and `/readyz`.
8. `deploy.yaml` still builds on push to `main` and commits the new image tag;
   `ci.yml` still runs the app's tests on pull requests.

When everything passes, say so in one short comment.
