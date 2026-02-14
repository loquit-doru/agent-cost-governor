# /retrospective - Continuous Learning Command

## Purpose
Analyze the current conversation session, extract learnings, and update relevant skills for continuous improvement.

## Instructions

When this command is invoked, follow these steps:

### Step 1: Analyze the Conversation
Review the entire conversation from this session and identify:
- **Tasks completed**: What was accomplished?
- **Challenges faced**: What problems or blockers occurred?
- **Solutions found**: How were issues resolved?
- **Mistakes made**: What went wrong and why?
- **Discoveries**: New patterns, tools, or approaches learned

### Step 2: Extract Learnings
Categorize findings into:

1. **What Worked Well** ✅
   - Successful approaches
   - Effective patterns
   - Useful commands or tools

2. **What Failed or Was Difficult** ❌
   - Failed approaches (and why)
   - Time-consuming tasks
   - Misunderstandings

3. **Key Insights** 💡
   - New understanding gained
   - Better ways to approach similar problems
   - Edge cases discovered

4. **Process Improvements** 🔄
   - Workflow optimizations
   - Shortcuts or automations
   - Documentation gaps identified

### Step 3: Update Skills
Based on the learnings, update the relevant skill file(s) in `.claude/skills/`:

1. **Add to Learnings Log**: Append new learnings with date
2. **Update Guidelines**: Modify workflow steps if needed
3. **Add Code Snippets**: Include useful code patterns discovered
4. **Update References**: Add links to relevant files

### Output Format

```markdown
## Retrospective Summary - [Date]

### Session Overview
[Brief description of what was worked on]

### ✅ What Worked
- [Learning 1]
- [Learning 2]

### ❌ What Failed/Struggled
- [Issue 1]: [Why and what to do differently]
- [Issue 2]: [Why and what to do differently]

### 💡 Key Insights
- [Insight 1]
- [Insight 2]

### 📝 Skill Updates Made
- Updated: [skill-name.md]
  - Added: [what was added]
  - Modified: [what was changed]

### 🎯 Action Items for Next Session
- [ ] [Action 1]
- [ ] [Action 2]
```

---

## Example Usage

After completing a development session:
```
/retrospective
```

Claude will then:
1. Review everything discussed in the conversation
2. Identify patterns, failures, and successes
3. Update the relevant skill files
4. Provide a summary of what was learned

---

## Notes
- Run this at the END of each session, not the beginning
- Be honest about failures - they're the best teachers
- Skills compound over time - small updates add up
