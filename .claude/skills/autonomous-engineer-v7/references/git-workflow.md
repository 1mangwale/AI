# Git Workflow — Safe Changes, Easy Rollback

## Golden Rule

**Every change is reversible. Save rollback points before touching code.**

---

## Before ANY Change

```bash
# 1. Check current state
git status
git log --oneline -5

# 2. Stash any uncommitted work
git stash push -m "WIP: [description]"

# 3. Record rollback point
export ROLLBACK=$(git rev-parse HEAD)
echo "Rollback point: $ROLLBACK"

# 4. Create feature branch
git checkout -b feat/[feature-name]

# 5. Document in .claude/PROGRESS.md
echo "- Started feat/[feature-name] from $ROLLBACK" >> .claude/PROGRESS.md
```

---

## Branch Naming Convention

```
feat/[feature]     — New feature
fix/[bug]          — Bug fix
refactor/[scope]   — Code refactor
test/[scope]       — Adding tests
docs/[scope]       — Documentation
chore/[task]       — Maintenance

Examples:
feat/user-auth
fix/login-redirect
refactor/api-validation
test/order-service
docs/api-endpoints
chore/update-deps
```

---

## Commit Message Format

```
type(scope): short description

Longer explanation if needed:
- What changed
- Why it changed
- Any breaking changes

Refs: #123 (if tracking issues)
```

### Types
| Type | When |
|------|------|
| feat | New feature |
| fix | Bug fix |
| refactor | Code change (no feature/fix) |
| test | Adding/updating tests |
| docs | Documentation only |
| chore | Maintenance, deps |
| style | Formatting only |
| perf | Performance improvement |

### Examples

```bash
# Simple
git commit -m "feat(auth): add JWT refresh token"

# Detailed
git commit -m "fix(orders): handle null quantity

- Added null check in calculateTotal()
- Returns 0 instead of NaN
- Added unit test for edge case

Fixes #42"
```

---

## During Development

### Frequent Commits
```bash
# After each logical unit of work
git add [specific files]
git commit -m "type(scope): what I did"

# NOT: git add . && git commit -m "changes"
```

### Check Your Progress
```bash
# See what's changed
git diff

# See staged changes
git diff --staged

# See commit history on branch
git log --oneline main..HEAD
```

### Save Work in Progress
```bash
# Quick save (unnamed)
git stash

# Named save
git stash push -m "WIP: working on validation"

# List stashes
git stash list

# Restore
git stash pop           # latest
git stash apply stash@{1}  # specific
```

---

## After Tests Pass

### Clean Up Commits (Optional)
```bash
# Interactive rebase to squash/reword
git rebase -i main

# In editor:
# pick abc123 feat(auth): initial setup
# squash def456 fix typo
# squash ghi789 add missing file
# (squash combines into previous commit)
```

### Merge to Main
```bash
# Update main first
git checkout main
git pull origin main

# Merge feature branch
git merge feat/[feature-name]

# Or rebase for linear history
git checkout feat/[feature-name]
git rebase main
git checkout main
git merge feat/[feature-name]
```

### Tag Version
```bash
# Annotated tag (preferred)
git tag -a v0.2.0 -m "Release: Add user authentication"

# Push tag
git push origin v0.2.0

# List tags
git tag -l
```

---

## Rollback Procedures

### Undo Last Commit (Keep Changes)
```bash
git reset --soft HEAD~1
# Changes are now staged, can re-commit
```

### Undo Last Commit (Discard Changes)
```bash
git reset --hard HEAD~1
# ⚠️ Changes are gone
```

### Revert Specific Commit (Safe)
```bash
# Creates new commit that undoes the specified commit
git revert [commit-hash]

# This is safest for shared branches
```

### Reset to Rollback Point
```bash
# Hard reset (discard everything after)
git reset --hard $ROLLBACK

# Soft reset (keep changes as unstaged)
git reset --soft $ROLLBACK
```

### Restore Single File
```bash
# From specific commit
git checkout [commit-hash] -- path/to/file

# From main branch
git checkout main -- path/to/file

# Discard local changes to file
git checkout -- path/to/file
```

### Recover Deleted Branch
```bash
# Find the commit
git reflog

# Recreate branch
git checkout -b recovered-branch [commit-hash]
```

### Fix Broken Merge
```bash
# Abort merge in progress
git merge --abort

# Or reset to before merge
git reset --hard ORIG_HEAD
```

---

## Emergency Procedures

### Everything Broke — Full Reset
```bash
# 1. Find last known good state
git reflog

# 2. Hard reset
git reset --hard [known-good-commit]

# 3. Document what happened
echo "Emergency reset to [commit]: [reason]" >> .claude/DECISIONS.md
```

### Need to Undo Pushed Commits
```bash
# Option 1: Revert (safe, creates new commits)
git revert HEAD~3..HEAD  # revert last 3 commits

# Option 2: Force push (dangerous, rewrites history)
git reset --hard [commit]
git push --force-with-lease  # safer than --force

# ⚠️ Only force push if you're the only one on the branch
```

### Lost Changes Recovery
```bash
# Git keeps everything for 30 days
git reflog

# Find your lost commit
git show [commit-hash]

# Recover it
git cherry-pick [commit-hash]
```

---

## Existing Project Workflow

### Initial Analysis
```bash
# 1. Clone/access the repo
git clone [url]
cd [project]

# 2. Check status
git status
git log --oneline -20
git branch -a

# 3. Save current HEAD
echo "Initial HEAD: $(git rev-parse HEAD)" > .claude/CODEBASE_AUDIT.md

# 4. Create audit branch
git checkout -b audit/initial-review
```

### Before Modifications
```bash
# 1. Ensure on feature branch (never modify main directly)
git checkout -b feat/[description]

# 2. Document starting point
cat >> .claude/PROGRESS.md << EOF

## Change: [description]
- Started: $(date)
- Branch: $(git branch --show-current)
- Rollback: $(git rev-parse HEAD)
EOF
```

### Safe Modification Pattern
```bash
# 1. Make small, atomic change
# 2. Test immediately
npm test

# 3. If tests pass: commit
git add [changed files]
git commit -m "type(scope): description"

# 4. If tests fail: discard
git checkout -- .
# or
git reset --hard HEAD

# 5. Repeat
```

---

## Git Aliases (Recommended)

Add to `~/.gitconfig`:

```ini
[alias]
  st = status -sb
  co = checkout
  br = branch
  ci = commit
  lg = log --oneline --graph -20
  unstage = reset HEAD --
  last = log -1 HEAD
  rollback = !echo $(git rev-parse HEAD)
  save = !git add -A && git commit -m 'WIP: savepoint'
  undo = reset --soft HEAD~1
  amend = commit --amend --no-edit
```

Usage:
```bash
git st        # short status
git lg        # pretty log
git save      # quick WIP commit
git undo      # undo last commit
git rollback  # print current commit hash
```

---

## Verification Checklist

Before merging to main:

```
□ All tests pass
□ Code reviewed (self or peer)
□ Commits are clean and atomic
□ No merge conflicts
□ PROGRESS.md updated
□ CHANGELOG.md updated (if release)
□ Version tagged (if release)
```

---

## Quick Reference

| Want to... | Command |
|------------|---------|
| Save rollback point | `ROLLBACK=$(git rev-parse HEAD)` |
| Create branch | `git checkout -b feat/name` |
| Undo last commit | `git reset --soft HEAD~1` |
| Discard all changes | `git reset --hard HEAD` |
| Revert pushed commit | `git revert [hash]` |
| Full reset | `git reset --hard $ROLLBACK` |
| Recover file | `git checkout [hash] -- file` |
| See history | `git reflog` |
| Stash work | `git stash push -m "desc"` |
| Restore stash | `git stash pop` |
