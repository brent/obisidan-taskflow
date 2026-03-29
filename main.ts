// main.ts
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { formatInTimeZone } from 'date-fns-tz';

// Define the interface for our plugin settings
interface TaskflowPluginSettings {
  rootFolder: string;
  taskLabel: string;
  templatePath: string;
  propertyName: string;
  trueFolder: string;
  falseFolder: string;
  iceboxFolder: string;
  enableBacklog: boolean;
  backlogFolder: string;
  enableCompletedDate: boolean;
  completedDatePropertyName: string;
  taskCounter: number;
  goalRootFolder: string;
  goalLabel: string;
  goalTemplatePath: string;
  goalPropertyName: string;
  goalTrueFolder: string;
  goalFalseFolder: string;
  goalIceboxFolder: string;
  goalBacklogFolder: string;
  enableGoalCompletedDate: boolean;
  goalCompletedDatePropertyName: string;
  goalCounter: number;
  childTaskCompletionBehavior: 'ask' | 'always' | 'never';
}

// Define default settings for the plugin
const DEFAULT_SETTINGS: TaskflowPluginSettings = {
  rootFolder: 'tasks',
  taskLabel: 'TASK',
  templatePath: '',
  propertyName: '✅',
  trueFolder: 'archive',
  falseFolder: '',
  iceboxFolder: 'icebox',
  enableBacklog: false,
  backlogFolder: 'backlog',
  enableCompletedDate: false,
  completedDatePropertyName: 'completed_date',
  taskCounter: 1,
  goalRootFolder: 'goals',
  goalLabel: 'GOAL',
  goalTemplatePath: '',
  goalPropertyName: '✅',
  goalTrueFolder: 'archive',
  goalFalseFolder: '',
  goalIceboxFolder: 'icebox',
  goalBacklogFolder: 'backlog',
  enableGoalCompletedDate: false,
  goalCompletedDatePropertyName: 'completed_date',
  goalCounter: 1,
  childTaskCompletionBehavior: 'ask',
};

// Builds an absolute vault path from a root and a relative sub-path.
// If sub is empty, returns root. If root is empty, sub is treated as absolute.
function buildPath(root: string, sub: string): string {
  if (!root) return sub;
  if (!sub) return root;
  return `${root}/${sub}`;
}

// Main plugin class
export default class TaskflowPlugin extends Plugin {
  settings: TaskflowPluginSettings = DEFAULT_SETTINGS;

  /**
   * Called when the plugin is loaded.
   */
  async onload() {
    const { needsTaskScan, needsGoalScan } = await this.loadSettings();

    this.addSettingTab(new TaskflowSettingTab(this.app, this));

    this.addCommand({
      id: 'create-task',
      name: 'Create task',
      callback: () => new CreateTaskModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'move-to-icebox',
      name: 'Move current task to icebox',
      callback: () => this.moveToIcebox(),
    });

    this.addCommand({
      id: 'move-out-of-backlog',
      name: 'Move current task out of backlog',
      checkCallback: (checking) => {
        if (!this.settings.enableBacklog) return false;
        if (checking) return true;
        this.moveOutOfBacklog();
        return true;
      },
    });

    this.addCommand({
      id: 'create-goal',
      name: 'Create goal',
      callback: () => new CreateGoalModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'move-goal-to-icebox',
      name: 'Move current goal to icebox',
      callback: () => this.moveGoalToIcebox(),
    });

    this.addCommand({
      id: 'move-goal-out-of-backlog',
      name: 'Move current goal out of backlog',
      callback: () => this.moveGoalOutOfBacklog(),
    });

    // ✅ FIX: Use the 'metadataCache.changed' event for instant frontmatter updates.
    // This is more reliable than 'vault.modify'.
    this.registerEvent(
      this.app.metadataCache.on('changed', async (file) => {
        // This event gives us the file that changed, which is all we need.
        await this.processFile(file);
        await this.processGoalFile(file);
      })
    );

    // Scan for the highest existing task/goal numbers on first install or when
    // upgrading from a version that didn't persist the counters.
    this.app.workspace.onLayoutReady(() => {
      if (needsTaskScan) this.detectTaskCounter();
      if (needsGoalScan) this.detectGoalCounter();
    });
  }

  /**
   * Called when the plugin is unloaded.
   */
  onunload() { }

  /**
   * Loads settings from Obsidian's data storage.
   * Returns which counters were absent (fresh install or legacy data).
   */
  async loadSettings(): Promise<{ needsTaskScan: boolean; needsGoalScan: boolean }> {
    const savedData = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
    return {
      needsTaskScan: !savedData || !('taskCounter' in savedData),
      needsGoalScan: !savedData || !('goalCounter' in savedData),
    };
  }

  /**
   * Saves the current plugin settings to disk.
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Scans the root folder for existing task files and sets taskCounter to
   * one above the highest TASK number found. Falls back to 1 if none exist.
   */
  async detectTaskCounter(): Promise<void> {
    const { rootFolder, taskLabel } = this.settings;
    const files = this.app.vault.getMarkdownFiles();
    let maxNum = 0;
    const pattern = new RegExp(`^\\[${taskLabel}-(\\d+)\\]`);

    for (const file of files) {
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) continue;
      const match = file.name.match(pattern);
      if (match) {
        const num = parseInt(match[1]!, 10);
        if (num > maxNum) maxNum = num;
      }
    }

    this.settings.taskCounter = maxNum + 1;
    await this.saveSettings();
  }

  /**
   * Scans the goal root folder for existing goal files and sets goalCounter to
   * one above the highest GOAL number found. Falls back to 1 if none exist.
   */
  async detectGoalCounter(): Promise<void> {
    const { goalRootFolder, goalLabel } = this.settings;
    const files = this.app.vault.getMarkdownFiles();
    let maxNum = 0;
    const pattern = new RegExp(`^\\[${goalLabel}-(\\d+)\\]`);

    for (const file of files) {
      if (goalRootFolder && !file.path.startsWith(`${goalRootFolder}/`)) continue;
      const match = file.name.match(pattern);
      if (match) {
        const num = parseInt(match[1]!, 10);
        if (num > maxNum) maxNum = num;
      }
    }

    this.settings.goalCounter = maxNum + 1;
    await this.saveSettings();
  }

  /**
   * Renames all task files to use the current taskLabel setting.
   * Skips files that would conflict with existing filenames.
   */
  async renameAllTaskFiles(): Promise<void> {
    const { rootFolder, taskLabel } = this.settings;
    const files = this.app.vault.getMarkdownFiles();
    const pattern = /^\[(.+?)-(\d+)\] (.+)\.md$/;

    let renamedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      // Only process files in the root folder
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) continue;

      const match = file.name.match(pattern);
      if (match) {
        const [, currentLabel, number, title] = match;

        // Skip if already using the correct label
        if (currentLabel === taskLabel) continue;

        // Build new filename with current label
        const newFileName = `[${taskLabel}-${number}] ${title}.md`;
        const newPath = file.parent ? `${file.parent.path}/${newFileName}` : newFileName;

        // Check if target already exists (conflict)
        const existing = this.app.vault.getAbstractFileByPath(newPath);
        if (existing) {
          skippedCount++;
          continue;
        }

        // Rename the file (this updates all links in the vault)
        await this.app.vault.rename(file, newPath);
        renamedCount++;
      }
    }

    new Notice(`Taskflow: Renamed ${renamedCount} task file(s). Skipped ${skippedCount} due to conflicts.`);
  }

  /**
   * Renames all goal files to use the current goalLabel setting.
   * Skips files that would conflict with existing filenames.
   */
  async renameAllGoalFiles(): Promise<void> {
    const { goalRootFolder, goalLabel } = this.settings;
    const files = this.app.vault.getMarkdownFiles();
    const pattern = /^\[(.+?)-(\d+)\] (.+)\.md$/;

    let renamedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      // Only process files in the goal root folder
      if (goalRootFolder && !file.path.startsWith(`${goalRootFolder}/`)) continue;

      const match = file.name.match(pattern);
      if (match) {
        const [, currentLabel, number, title] = match;

        // Skip if already using the correct label
        if (currentLabel === goalLabel) continue;

        // Build new filename with current label
        const newFileName = `[${goalLabel}-${number}] ${title}.md`;
        const newPath = file.parent ? `${file.parent.path}/${newFileName}` : newFileName;

        // Check if target already exists (conflict)
        const existing = this.app.vault.getAbstractFileByPath(newPath);
        if (existing) {
          skippedCount++;
          continue;
        }

        // Rename the file (this updates all links in the vault)
        await this.app.vault.rename(file, newPath);
        renamedCount++;
      }
    }

    new Notice(`Taskflow: Renamed ${renamedCount} goal file(s). Skipped ${skippedCount} due to conflicts.`);
  }

  /**
   * Moves the currently active task file to the configured icebox folder.
   */
  async moveToIcebox() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    const { taskLabel, rootFolder, iceboxFolder } = this.settings;
    if (!activeFile.name.startsWith(`[${taskLabel}-`)) {
      new Notice('Taskflow: Active file is not a task file.');
      return;
    }
    const absoluteIcebox = buildPath(rootFolder, iceboxFolder);
    if (!absoluteIcebox) {
      new Notice('Taskflow: Icebox folder is not configured.');
      return;
    }

    const currentFolder = activeFile.parent?.path || '';
    if (currentFolder === absoluteIcebox) {
      new Notice('Taskflow: File is already in the icebox.');
      return;
    }

    const newPath = `${absoluteIcebox}/${activeFile.name}`;
    await this.ensureFolder(absoluteIcebox);
    await this.app.vault.rename(activeFile, newPath);
    new Notice('Taskflow: Moved to icebox.');
  }

  /**
   * Moves the currently active task file from the backlog to the root folder.
   */
  async moveOutOfBacklog() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    const { taskLabel, rootFolder } = this.settings;
    if (!activeFile.name.startsWith(`[${taskLabel}-`)) {
      new Notice('Taskflow: Active file is not a task file.');
      return;
    }
    const targetFolder = rootFolder || '';
    const currentFolder = activeFile.parent?.path || '';

    if (currentFolder === targetFolder) {
      new Notice('Taskflow: File is already in the root folder.');
      return;
    }

    const newPath = targetFolder
      ? `${targetFolder}/${activeFile.name}`
      : activeFile.name;
    await this.ensureFolder(targetFolder);
    await this.app.vault.rename(activeFile, newPath);
    new Notice('Taskflow: Moved out of backlog.');
  }

  /**
   * Moves the currently active goal file to the configured goal icebox folder.
   */
  async moveGoalToIcebox() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    const { goalLabel, goalRootFolder, goalIceboxFolder } = this.settings;
    if (!activeFile.name.startsWith(`[${goalLabel}-`)) {
      new Notice('Taskflow: Active file is not a goal file.');
      return;
    }
    const absoluteIcebox = buildPath(goalRootFolder, goalIceboxFolder);
    if (!absoluteIcebox) {
      new Notice('Taskflow: Goal icebox folder is not configured.');
      return;
    }

    const currentFolder = activeFile.parent?.path || '';
    if (currentFolder === absoluteIcebox) {
      new Notice('Taskflow: File is already in the icebox.');
      return;
    }

    const newPath = `${absoluteIcebox}/${activeFile.name}`;
    await this.ensureFolder(absoluteIcebox);
    await this.app.vault.rename(activeFile, newPath);
    new Notice('Taskflow: Moved to icebox.');
  }

  /**
   * Moves the currently active goal file from the backlog to the goal root folder.
   */
  async moveGoalOutOfBacklog() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    const { goalLabel, goalRootFolder } = this.settings;
    if (!activeFile.name.startsWith(`[${goalLabel}-`)) {
      new Notice('Taskflow: Active file is not a goal file.');
      return;
    }
    const targetFolder = goalRootFolder || '';
    const currentFolder = activeFile.parent?.path || '';

    if (currentFolder === targetFolder) {
      new Notice('Taskflow: File is already in the goal root folder.');
      return;
    }

    const newPath = targetFolder
      ? `${targetFolder}/${activeFile.name}`
      : activeFile.name;
    await this.ensureFolder(targetFolder);
    await this.app.vault.rename(activeFile, newPath);
    new Notice('Taskflow: Moved out of backlog.');
  }

  /**
   * Ensures a folder path exists, creating any missing intermediate directories.
   */
  async ensureFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  /**
   * Creates all configured task and goal folders if they don't already exist.
   */
  async bootstrapFolderStructure(): Promise<void> {
    const foldersToCreate: string[] = [];

    // Task folders
    const { rootFolder, trueFolder, falseFolder, iceboxFolder, enableBacklog, backlogFolder } = this.settings;

    if (rootFolder) {
      foldersToCreate.push(rootFolder);

      const taskTrueFolder = buildPath(rootFolder, trueFolder);
      if (taskTrueFolder) foldersToCreate.push(taskTrueFolder);

      const taskFalseFolder = buildPath(rootFolder, falseFolder);
      if (taskFalseFolder && taskFalseFolder !== rootFolder) foldersToCreate.push(taskFalseFolder);

      const taskIceboxFolder = buildPath(rootFolder, iceboxFolder);
      if (taskIceboxFolder) foldersToCreate.push(taskIceboxFolder);

      if (enableBacklog) {
        const taskBacklogFolder = buildPath(rootFolder, backlogFolder);
        if (taskBacklogFolder) foldersToCreate.push(taskBacklogFolder);
      }
    }

    // Goal folders
    const { goalRootFolder, goalTrueFolder, goalFalseFolder, goalIceboxFolder, goalBacklogFolder } = this.settings;

    if (goalRootFolder) {
      foldersToCreate.push(goalRootFolder);

      const gTrueFolder = buildPath(goalRootFolder, goalTrueFolder);
      if (gTrueFolder) foldersToCreate.push(gTrueFolder);

      const gFalseFolder = buildPath(goalRootFolder, goalFalseFolder);
      if (gFalseFolder && gFalseFolder !== goalRootFolder) foldersToCreate.push(gFalseFolder);

      const gIceboxFolder = buildPath(goalRootFolder, goalIceboxFolder);
      if (gIceboxFolder) foldersToCreate.push(gIceboxFolder);

      const gBacklogFolder = buildPath(goalRootFolder, goalBacklogFolder);
      if (gBacklogFolder) foldersToCreate.push(gBacklogFolder);
    }

    // Create all folders
    for (const folder of foldersToCreate) {
      await this.ensureFolder(folder);
    }

    new Notice(`Taskflow: Folder structure created. Checked ${foldersToCreate.length} folder(s).`);
  }

  /**
   * Processes a given Markdown file to determine if it needs to be moved.
   * @param file The TFile object representing the Markdown file.
   */
  processing = new Set<string>();
  async processFile(file: TFile) {
    const originalPath = file.path;
    if (this.processing.has(originalPath)) {
      return;
    }

    this.processing.add(originalPath);

    try {
      const { rootFolder, propertyName, trueFolder, falseFolder, enableCompletedDate, completedDatePropertyName } = this.settings;

      // If a root folder is configured, only process files inside it.
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) {
        return;
      }

      const absoluteTrueFolder = buildPath(rootFolder, trueFolder);
      const absoluteFalseFolder = buildPath(rootFolder, falseFolder);

      if (!propertyName || !absoluteTrueFolder || !absoluteFalseFolder) {
        console.warn('Taskflow Plugin: Settings are incomplete.');
        return;
      }

      const fileCache = this.app.metadataCache.getFileCache(file);
      if (!fileCache || !fileCache.frontmatter) {
        return; // No frontmatter, so nothing to do.
      }

      const propertyValue = fileCache.frontmatter[propertyName];
      let targetFolder = '';

      if (propertyValue === true) {
        targetFolder = absoluteTrueFolder;
      } else if (propertyValue === false) {
        targetFolder = absoluteFalseFolder;
      } else {
        return; // Property not found or not a boolean.
      }

      const currentFolderPath = file.parent?.path || '';
      if (currentFolderPath === targetFolder) {
        return; // Already in the correct folder.
      }

      const newPath = `${targetFolder}/${file.name}`;

      await this.ensureFolder(targetFolder);

      // 1. Move the file first.
      await this.app.vault.rename(file, newPath);
      console.log(`Taskflow Plugin: Moved "${originalPath}" to "${newPath}"`);

      // 2. Then, modify the frontmatter in the new location.
      if (enableCompletedDate && completedDatePropertyName) {
        if (propertyValue === true) {
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            if (!frontmatter[completedDatePropertyName]) {
              const now = new Date();
              const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              frontmatter[completedDatePropertyName] = formatInTimeZone(now, timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
            }
          });
        } else if (propertyValue === false) {
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            delete frontmatter[completedDatePropertyName];
          });
        }
      }

    } catch (e) {
      console.error(`Taskflow Plugin: Error processing "${originalPath}":`, e);
    } finally {
      this.processing.delete(originalPath);
    }
  }

  findChildTasks(goalFile: TFile): TFile[] {
    const { rootFolder } = this.settings;
    const goalName = goalFile.basename;
    const allFiles = this.app.vault.getMarkdownFiles();
    const children: TFile[] = [];

    for (const file of allFiles) {
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatter) continue;
      let parent = cache.frontmatter['parent'];
      if (typeof parent !== 'string' || !parent) continue;
      // Strip wiki-link brackets if present
      parent = parent.replace(/^\[\[|\]\]$/g, '');
      // Strip .md extension if present
      parent = parent.replace(/\.md$/, '');
      if (parent === goalName) {
        children.push(file);
      }
    }
    return children;
  }

  async completeChildTasks(children: TFile[]): Promise<void> {
    const { propertyName } = this.settings;
    for (const child of children) {
      await this.app.fileManager.processFrontMatter(child, (frontmatter) => {
        frontmatter[propertyName] = true;
      });
    }
  }

  askCompleteChildren(childCount: number): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const safeResolve = (val: boolean) => { if (!resolved) { resolved = true; resolve(val); } };
      new CompleteChildTasksModal(this.app, childCount, safeResolve).open();
    });
  }

  /**
   * Processes a given Markdown file to determine if it needs to be moved (goal workflow).
   * @param file The TFile object representing the Markdown file.
   */
  async processGoalFile(file: TFile) {
    const originalPath = file.path;
    if (this.processing.has(originalPath)) {
      return;
    }

    this.processing.add(originalPath);

    try {
      const { goalRootFolder, goalPropertyName, goalTrueFolder, goalFalseFolder, enableGoalCompletedDate, goalCompletedDatePropertyName } = this.settings;

      // If a goal root folder is configured, only process files inside it.
      if (goalRootFolder && !file.path.startsWith(`${goalRootFolder}/`)) {
        return;
      }

      const absoluteTrueFolder = buildPath(goalRootFolder, goalTrueFolder);
      const absoluteFalseFolder = buildPath(goalRootFolder, goalFalseFolder);

      if (!goalPropertyName || !absoluteTrueFolder || !absoluteFalseFolder) {
        console.warn('Taskflow Plugin: Goal settings are incomplete.');
        return;
      }

      const fileCache = this.app.metadataCache.getFileCache(file);
      if (!fileCache || !fileCache.frontmatter) {
        return; // No frontmatter, so nothing to do.
      }

      const propertyValue = fileCache.frontmatter[goalPropertyName];
      let targetFolder = '';

      if (propertyValue === true) {
        targetFolder = absoluteTrueFolder;
      } else if (propertyValue === false) {
        targetFolder = absoluteFalseFolder;
      } else {
        return; // Property not found or not a boolean.
      }

      const currentFolderPath = file.parent?.path || '';
      if (currentFolderPath === targetFolder) {
        return; // Already in the correct folder.
      }

      const newPath = `${targetFolder}/${file.name}`;

      await this.ensureFolder(targetFolder);

      // 1. Move the file first.
      await this.app.vault.rename(file, newPath);
      console.log(`Taskflow Plugin: Moved "${originalPath}" to "${newPath}"`);

      // 2. Then, modify the frontmatter in the new location.
      if (enableGoalCompletedDate && goalCompletedDatePropertyName) {
        if (propertyValue === true) {
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            if (!frontmatter[goalCompletedDatePropertyName]) {
              const now = new Date();
              const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              frontmatter[goalCompletedDatePropertyName] = formatInTimeZone(now, timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
            }
          });
        } else if (propertyValue === false) {
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            delete frontmatter[goalCompletedDatePropertyName];
          });
        }
      }

      // Handle child task completion when goal is marked done
      if (propertyValue === true) {
        const behavior = this.settings.childTaskCompletionBehavior;
        if (behavior !== 'never') {
          const children = this.findChildTasks(file);
          if (children.length > 0) {
            let shouldComplete = behavior === 'always';
            if (behavior === 'ask') {
              shouldComplete = await this.askCompleteChildren(children.length);
            }
            if (shouldComplete) {
              await this.completeChildTasks(children);
            }
          }
        }
      }

    } catch (e) {
      console.error(`Taskflow Plugin: Error processing "${originalPath}":`, e);
    } finally {
      this.processing.delete(originalPath);
    }
  }
}

class CreateTaskModal extends Modal {
  plugin: TaskflowPlugin;

  constructor(app: App, plugin: TaskflowPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'New task' });

    const input = contentEl.createEl('input', { type: 'text' });
    input.placeholder = 'Task title';
    input.style.width = '100%';
    input.style.marginBottom = '1em';

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') await this.createTask(input.value);
    });

    const button = contentEl.createEl('button', { text: 'Create' });
    button.addEventListener('click', async () => await this.createTask(input.value));

    // Focus the input after the modal finishes animating open.
    setTimeout(() => input.focus(), 50);
  }

  async createTask(title: string) {
    title = title.trim();
    if (!title) return;

    const { rootFolder, taskLabel, taskCounter, propertyName, templatePath, enableBacklog, backlogFolder } = this.plugin.settings;
    const paddedNum = String(taskCounter).padStart(3, '0');
    const fileName = `[${taskLabel}-${paddedNum}] ${title}.md`;
    const targetFolder = enableBacklog
      ? buildPath(rootFolder, backlogFolder)
      : (rootFolder || '');
    const filePath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    let content: string;
    const templateFile = templatePath
      ? this.app.vault.getAbstractFileByPath(templatePath)
      : null;
    if (templateFile instanceof TFile) {
      content = await this.app.vault.read(templateFile);
    } else {
      content = [
        '---',
        `${propertyName}: false`,
        '🚩: false',
        'due: ',
        'deferred: ',
        'started: ',
        'parent: ',
        '---',
        '',
      ].join('\n');
    }

    await this.plugin.ensureFolder(targetFolder);

    // Suppress processFile from reacting to the newly created file.
    this.plugin.processing.add(filePath);
    const file = await this.app.vault.create(filePath, content);
    setTimeout(() => this.plugin.processing.delete(filePath), 500);

    // Increment and persist the counter.
    this.plugin.settings.taskCounter = taskCounter + 1;
    await this.plugin.saveSettings();

    this.close();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CreateGoalModal extends Modal {
  plugin: TaskflowPlugin;

  constructor(app: App, plugin: TaskflowPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'New goal' });

    const input = contentEl.createEl('input', { type: 'text' });
    input.placeholder = 'Goal title';
    input.style.width = '100%';
    input.style.marginBottom = '1em';

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') await this.createGoal(input.value);
    });

    const button = contentEl.createEl('button', { text: 'Create' });
    button.addEventListener('click', async () => await this.createGoal(input.value));

    // Focus the input after the modal finishes animating open.
    setTimeout(() => input.focus(), 50);
  }

  async createGoal(title: string) {
    title = title.trim();
    if (!title) return;

    const { goalRootFolder, goalLabel, goalCounter, goalPropertyName, goalTemplatePath, goalBacklogFolder } = this.plugin.settings;
    const paddedNum = String(goalCounter).padStart(3, '0');
    const fileName = `[${goalLabel}-${paddedNum}] ${title}.md`;
    // Goals always go to backlog folder
    const targetFolder = buildPath(goalRootFolder, goalBacklogFolder);
    const filePath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    let content: string;
    const templateFile = goalTemplatePath
      ? this.app.vault.getAbstractFileByPath(goalTemplatePath)
      : null;
    if (templateFile instanceof TFile) {
      content = await this.app.vault.read(templateFile);
    } else {
      content = [
        '---',
        `${goalPropertyName}: false`,
        '🚩: false',
        'due: ',
        'deferred: ',
        'started: ',
        'parent: ',
        '---',
        '',
      ].join('\n');
    }

    await this.plugin.ensureFolder(targetFolder);

    // Suppress processGoalFile from reacting to the newly created file.
    this.plugin.processing.add(filePath);
    const file = await this.app.vault.create(filePath, content);
    setTimeout(() => this.plugin.processing.delete(filePath), 500);

    // Increment and persist the counter.
    this.plugin.settings.goalCounter = goalCounter + 1;
    await this.plugin.saveSettings();

    this.close();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CompleteChildTasksModal extends Modal {
  private resolvePromise: (value: boolean) => void;
  private childCount: number;

  constructor(app: App, childCount: number, resolvePromise: (value: boolean) => void) {
    super(app);
    this.childCount = childCount;
    this.resolvePromise = resolvePromise;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Complete child tasks?' });
    contentEl.createEl('p', {
      text: `This goal has ${this.childCount} child task(s). Mark them as completed?`
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const yesBtn = buttonContainer.createEl('button', { text: 'Yes, complete them', cls: 'mod-cta' });
    yesBtn.addEventListener('click', () => {
      this.resolvePromise(true);
      this.close();
    });

    const noBtn = buttonContainer.createEl('button', { text: 'No, leave them' });
    noBtn.addEventListener('click', () => {
      this.resolvePromise(false);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
    // If closed via escape/click-outside, treat as "no"
    this.resolvePromise(false);
  }
}

// Settings tab class remains the same
class TaskflowSettingTab extends PluginSettingTab {
  plugin: TaskflowPlugin;

  constructor(app: App, plugin: TaskflowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Taskflow settings' });

    containerEl.createEl('h2', { text: 'Task Settings' });

    new Setting(containerEl)
      .setName('Root Folder')
      .setDesc('Scope the plugin to files inside this folder. The "True" and "False" folder paths below are relative to this root. Leave empty to watch the entire vault (folder paths will be treated as absolute).')
      .addText(text => text
        .setPlaceholder('taskflow')
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async (value) => {
          this.plugin.settings.rootFolder = value;
          await this.plugin.saveSettings();
          await this.plugin.detectTaskCounter();
        }));

    new Setting(containerEl)
      .setName('Task Label')
      .setDesc('The label used in task filenames (e.g., "TASK" creates "[TASK-001] My Task.md"). Use the button to rename all existing task files to match the current label.')
      .addText(text => text
        .setPlaceholder('TASK')
        .setValue(this.plugin.settings.taskLabel)
        .onChange(async (value) => {
          this.plugin.settings.taskLabel = value;
          await this.plugin.saveSettings();
        }))
      .addButton(button => button
        .setButtonText('Update task filenames to current label')
        .setTooltip('Rename all task files in the root folder to use the current label')
        .onClick(async () => {
          await this.plugin.renameAllTaskFiles();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Task Template')
      .setDesc('Path to a template file used when creating tasks. Falls back to the default frontmatter if the file does not exist. The file will not be created automatically.')
      .addText(text => text
        .setPlaceholder('templates/task.md')
        .setValue(this.plugin.settings.templatePath)
        .onChange(async (value) => {
          this.plugin.settings.templatePath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Completed Property Name')
      .setDesc('The name of the frontmatter property (e.g., "completed") that will trigger the file move.')
      .addText(text => text
        .setPlaceholder('✅')
        .setValue(this.plugin.settings.propertyName)
        .onChange(async (value) => {
          this.plugin.settings.propertyName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Completed Folder')
      .setDesc('The folder where the file will be moved when the completed property is set to `true`. Relative to Root Folder if one is set.')
      .addText(text => text
        .setPlaceholder('archive')
        .setValue(this.plugin.settings.trueFolder)
        .onChange(async (value) => {
          this.plugin.settings.trueFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Uncompleted Folder')
      .setDesc('The folder where the file will be moved back to when the completed property is set to `false`. Relative to Root Folder if one is set. Leave blank to use the Root Folder itself.')
      .addText(text => text
        .setPlaceholder('Leave blank to use Root Folder')
        .setValue(this.plugin.settings.falseFolder)
        .onChange(async (value) => {
          this.plugin.settings.falseFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Icebox Folder')
      .setDesc('Files moved to the icebox are placed here. Relative to Root Folder if one is set. Leave blank to use the Root Folder itself.')
      .addText(text => text
        .setPlaceholder('icebox')
        .setValue(this.plugin.settings.iceboxFolder)
        .onChange(async (value) => {
          this.plugin.settings.iceboxFolder = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Backlog Settings' });

    new Setting(containerEl)
      .setName('Enable Backlog')
      .setDesc('When enabled, new tasks are created in the backlog folder instead of the root. A command to move tasks out of the backlog becomes available.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableBacklog)
        .onChange(async (value) => {
          this.plugin.settings.enableBacklog = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableBacklog) {
      new Setting(containerEl)
        .setName('Backlog Folder')
        .setDesc('New tasks are created here. Relative to Root Folder if one is set.')
        .addText(text => text
          .setPlaceholder('backlog')
          .setValue(this.plugin.settings.backlogFolder)
          .onChange(async (value) => {
            this.plugin.settings.backlogFolder = value;
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl('h3', { text: 'Completed Date Settings' });

    new Setting(containerEl)
      .setName('Enable Completed Date')
      .setDesc('When a checkbox property is checked, add a completed date property.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableCompletedDate)
        .onChange(async (value) => {
          this.plugin.settings.enableCompletedDate = value;
          await this.plugin.saveSettings();
          this.display(); // Refresh the settings pane
        }));

    if (this.plugin.settings.enableCompletedDate) {
      new Setting(containerEl)
        .setName('Completed Date Property Name')
        .setDesc('The name of the frontmatter property to store the completed date.')
        .addText(text => text
          .setPlaceholder('completed_date')
          .setValue(this.plugin.settings.completedDatePropertyName)
          .onChange(async (value) => {
            this.plugin.settings.completedDatePropertyName = value;
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl('h3', { text: 'Task Counter' });

    new Setting(containerEl)
      .setName('Next task number')
      .setDesc('The number used for the next created task. Edit manually or rescan to set it from existing files.')
      .addText(text => text
        .setValue(String(this.plugin.settings.taskCounter))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.taskCounter = num;
            await this.plugin.saveSettings();
          }
        }))
      .addButton(button => button
        .setButtonText('Rescan')
        .setTooltip('Scan root folder for existing task files and set counter accordingly')
        .onClick(async () => {
          await this.plugin.detectTaskCounter();
          this.display();
        }));

    containerEl.createEl('h2', { text: 'Goal Settings' });

    new Setting(containerEl)
      .setName('Goal Root Folder')
      .setDesc('Scope goal files to this folder. The goal sub-folders below are relative to this root. Leave empty to watch the entire vault.')
      .addText(text => text
        .setPlaceholder('goals')
        .setValue(this.plugin.settings.goalRootFolder)
        .onChange(async (value) => {
          this.plugin.settings.goalRootFolder = value;
          await this.plugin.saveSettings();
          await this.plugin.detectGoalCounter();
        }));

    new Setting(containerEl)
      .setName('Goal Label')
      .setDesc('The label used in goal filenames (e.g., "GOAL" creates "[GOAL-001] My Goal.md"). Use the button to rename all existing goal files to match the current label.')
      .addText(text => text
        .setPlaceholder('GOAL')
        .setValue(this.plugin.settings.goalLabel)
        .onChange(async (value) => {
          this.plugin.settings.goalLabel = value;
          await this.plugin.saveSettings();
        }))
      .addButton(button => button
        .setButtonText('Update goal filenames to current label')
        .setTooltip('Rename all goal files in the goal root folder to use the current label')
        .onClick(async () => {
          await this.plugin.renameAllGoalFiles();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Goal Template')
      .setDesc('Path to a template file used when creating goals. Falls back to the default frontmatter if the file does not exist.')
      .addText(text => text
        .setPlaceholder('templates/goal.md')
        .setValue(this.plugin.settings.goalTemplatePath)
        .onChange(async (value) => {
          this.plugin.settings.goalTemplatePath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Completed Property Name')
      .setDesc('The name of the frontmatter property that will trigger the goal file move.')
      .addText(text => text
        .setPlaceholder('✅')
        .setValue(this.plugin.settings.goalPropertyName)
        .onChange(async (value) => {
          this.plugin.settings.goalPropertyName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Completed Folder')
      .setDesc('Where goals are moved when the completed property is set to `true`. Relative to Goal Root Folder if one is set.')
      .addText(text => text
        .setPlaceholder('archive')
        .setValue(this.plugin.settings.goalTrueFolder)
        .onChange(async (value) => {
          this.plugin.settings.goalTrueFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Uncompleted Folder')
      .setDesc('Where goals are moved when the completed property is set to `false`. Relative to Goal Root Folder if one is set. Leave blank to use the Goal Root Folder itself.')
      .addText(text => text
        .setPlaceholder('Leave blank to use Goal Root Folder')
        .setValue(this.plugin.settings.goalFalseFolder)
        .onChange(async (value) => {
          this.plugin.settings.goalFalseFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Goal Icebox Folder')
      .setDesc('Goals moved to the icebox are placed here. Relative to Goal Root Folder if one is set. Leave blank to use the Goal Root Folder itself.')
      .addText(text => text
        .setPlaceholder('icebox')
        .setValue(this.plugin.settings.goalIceboxFolder)
        .onChange(async (value) => {
          this.plugin.settings.goalIceboxFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Goal Backlog Folder')
      .setDesc('New goals are created here. Relative to Goal Root Folder if one is set.')
      .addText(text => text
        .setPlaceholder('backlog')
        .setValue(this.plugin.settings.goalBacklogFolder)
        .onChange(async (value) => {
          this.plugin.settings.goalBacklogFolder = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Child Task Completion' });

    new Setting(containerEl)
      .setName('When a goal is completed')
      .setDesc('Controls whether child tasks (tasks with a "parent" field matching the goal) are automatically marked as completed.')
      .addDropdown(dropdown => dropdown
        .addOption('ask', 'Ask me each time')
        .addOption('always', 'Always complete child tasks')
        .addOption('never', 'Never complete child tasks')
        .setValue(this.plugin.settings.childTaskCompletionBehavior)
        .onChange(async (value: string) => {
          this.plugin.settings.childTaskCompletionBehavior = value as 'ask' | 'always' | 'never';
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Goal Completed Date Settings' });

    new Setting(containerEl)
      .setName('Enable Goal Completed Date')
      .setDesc('When a goal property is checked, add a completed date property.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableGoalCompletedDate)
        .onChange(async (value) => {
          this.plugin.settings.enableGoalCompletedDate = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableGoalCompletedDate) {
      new Setting(containerEl)
        .setName('Goal Completed Date Property Name')
        .setDesc('The name of the frontmatter property to store the goal completed date.')
        .addText(text => text
          .setPlaceholder('completed_date')
          .setValue(this.plugin.settings.goalCompletedDatePropertyName)
          .onChange(async (value) => {
            this.plugin.settings.goalCompletedDatePropertyName = value;
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl('h3', { text: 'Goal Counter' });

    new Setting(containerEl)
      .setName('Next goal number')
      .setDesc('The number used for the next created goal. Edit manually or rescan to set it from existing files.')
      .addText(text => text
        .setValue(String(this.plugin.settings.goalCounter))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.goalCounter = num;
            await this.plugin.saveSettings();
          }
        }))
      .addButton(button => button
        .setButtonText('Rescan')
        .setTooltip('Scan goal root folder for existing goal files and set counter accordingly')
        .onClick(async () => {
          await this.plugin.detectGoalCounter();
          this.display();
        }));

    containerEl.createEl('h2', { text: 'Folder Setup' });

    new Setting(containerEl)
      .setName('Bootstrap Folder Structure')
      .setDesc('Create all configured task and goal folders if they don\'t already exist. This includes root folders, archive, icebox, backlog (if enabled), and uncompleted folders.')
      .addButton(button => button
        .setButtonText('Create folder structure')
        .setTooltip('Create all configured folders')
        .onClick(async () => {
          await this.plugin.bootstrapFolderStructure();
        }));
  }
}
