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
  childTaskFlagBehavior: 'ask' | 'always' | 'never';
  enableTaskRoutingDialog: boolean;
  enableGoalRoutingDialog: boolean;
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
  completedDatePropertyName: 'done',
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
  goalCompletedDatePropertyName: 'done',
  goalCounter: 1,
  childTaskCompletionBehavior: 'ask',
  childTaskFlagBehavior: 'ask',
  enableTaskRoutingDialog: false,
  enableGoalRoutingDialog: false,
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
      name: 'Icebox task',
      callback: () => this.moveTaskToIcebox(),
    });

    this.addCommand({
      id: 'move-out-of-backlog',
      name: 'Make task active',
      checkCallback: (checking) => {
        if (!this.settings.enableBacklog) return false;
        if (checking) return true;
        this.moveTaskOutOfBacklog();
        return true;
      },
    });

    this.addCommand({
      id: 'backlog-task',
      name: 'Backlog task',
      checkCallback: (checking) => {
        if (!this.settings.enableBacklog) return false;
        if (checking) return true;
        this.moveTaskToBacklog();
        return true;
      },
    });

    this.addCommand({
      id: 'archive-task',
      name: 'Archive task',
      callback: () => this.archiveTask(),
    });

    this.addCommand({
      id: 'create-goal',
      name: 'Create goal',
      callback: () => new CreateGoalModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'move-goal-to-icebox',
      name: 'Icebox goal',
      callback: () => this.moveGoalToIcebox(),
    });

    this.addCommand({
      id: 'move-goal-out-of-backlog',
      name: 'Make goal active',
      callback: () => this.moveGoalOutOfBacklog(),
    });

    this.addCommand({
      id: 'backlog-goal',
      name: 'Backlog goal',
      callback: () => this.moveGoalToBacklog(),
    });

    this.addCommand({
      id: 'archive-goal',
      name: 'Archive goal',
      callback: () => this.archiveGoal(),
    });

    // ✅ FIX: Use the 'metadataCache.changed' event for instant frontmatter updates.
    // This is more reliable than 'vault.modify'.
    this.registerEvent(
      this.app.metadataCache.on('changed', async (file) => {
        // This event gives us the file that changed, which is all we need.
        await this.processTaskFile(file);
        await this.processGoalFile(file);
      })
    );

    // Scan for the highest existing task/goal numbers on first install or when
    // upgrading from a version that didn't persist the counters.
    this.app.workspace.onLayoutReady(() => {
      if (needsTaskScan) this.detectTaskCounter();
      if (needsGoalScan) this.detectGoalCounter();
      this.initDoneTracking();
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

  private async detectCounter(rootFolder: string, label: string, setter: (n: number) => void): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let maxNum = 0;
    const pattern = new RegExp(`^\\[${label}-(\\d+)\\]`);
    for (const file of files) {
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) continue;
      const match = file.name.match(pattern);
      if (match) {
        const num = parseInt(match[1]!, 10);
        if (num > maxNum) maxNum = num;
      }
    }
    setter(maxNum + 1);
    await this.saveSettings();
  }

  async detectTaskCounter(): Promise<void> {
    await this.detectCounter(this.settings.rootFolder, this.settings.taskLabel, n => { this.settings.taskCounter = n; });
  }

  async detectGoalCounter(): Promise<void> {
    await this.detectCounter(this.settings.goalRootFolder, this.settings.goalLabel, n => { this.settings.goalCounter = n; });
  }

  private async renameAllFiles(rootFolder: string, label: string, fileType: string): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const pattern = /^\[(.+?)-(\d+)\] (.+)\.md$/;
    let renamedCount = 0;
    let skippedCount = 0;
    for (const file of files) {
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) continue;
      const match = file.name.match(pattern);
      if (!match) continue;
      const [, currentLabel, number, title] = match;
      if (currentLabel === label) continue;
      const newFileName = `[${label}-${number}] ${title}.md`;
      const newPath = file.parent ? `${file.parent.path}/${newFileName}` : newFileName;
      if (this.app.vault.getAbstractFileByPath(newPath)) { skippedCount++; continue; }
      await this.app.vault.rename(file, newPath);
      renamedCount++;
    }
    new Notice(`Taskflow: Renamed ${renamedCount} ${fileType} file(s). Skipped ${skippedCount} due to conflicts.`);
  }

  async renameAllTaskFiles(): Promise<void> {
    await this.renameAllFiles(this.settings.rootFolder, this.settings.taskLabel, 'task');
  }

  async renameAllGoalFiles(): Promise<void> {
    await this.renameAllFiles(this.settings.goalRootFolder, this.settings.goalLabel, 'goal');
  }

  /**
   * Moves the currently active task file to the configured icebox folder.
   */
  async moveTaskToIcebox() {
    const { taskLabel, rootFolder, iceboxFolder } = this.settings;
    await this.manualMoveFile({
      label: taskLabel, fileType: 'task',
      targetFolder: buildPath(rootFolder, iceboxFolder),
      notConfiguredMsg: 'Taskflow: Icebox folder is not configured.',
      alreadyThereMsg: 'Taskflow: File is already in the icebox.',
      movedMsg: 'Taskflow: Moved to icebox.',
    });
  }

  async moveTaskOutOfBacklog() {
    const { taskLabel, rootFolder } = this.settings;
    await this.manualMoveFile({
      label: taskLabel, fileType: 'task',
      targetFolder: rootFolder || '',
      notConfiguredMsg: '',
      alreadyThereMsg: 'Taskflow: File is already in the root folder.',
      movedMsg: 'Taskflow: Moved out of backlog.',
    });
  }

  async moveGoalToIcebox() {
    const { goalLabel, goalRootFolder, goalIceboxFolder } = this.settings;
    await this.manualMoveFile({
      label: goalLabel, fileType: 'goal',
      targetFolder: buildPath(goalRootFolder, goalIceboxFolder),
      notConfiguredMsg: 'Taskflow: Goal icebox folder is not configured.',
      alreadyThereMsg: 'Taskflow: File is already in the icebox.',
      movedMsg: 'Taskflow: Moved to icebox.',
    });
  }

  async moveGoalOutOfBacklog() {
    const { goalLabel, goalRootFolder } = this.settings;
    await this.manualMoveFile({
      label: goalLabel, fileType: 'goal',
      targetFolder: goalRootFolder || '',
      notConfiguredMsg: '',
      alreadyThereMsg: 'Taskflow: File is already in the goal root folder.',
      movedMsg: 'Taskflow: Moved out of backlog.',
    });
  }

  async moveTaskToBacklog() {
    const { taskLabel, rootFolder, backlogFolder } = this.settings;
    await this.manualMoveFile({
      label: taskLabel, fileType: 'task',
      targetFolder: buildPath(rootFolder, backlogFolder),
      notConfiguredMsg: 'Taskflow: Backlog folder is not configured.',
      alreadyThereMsg: 'Taskflow: File is already in the backlog.',
      movedMsg: 'Taskflow: Moved to backlog.',
    });
  }

  async archiveTask() {
    const { taskLabel, rootFolder, trueFolder } = this.settings;
    await this.manualMoveFile({
      label: taskLabel, fileType: 'task',
      targetFolder: buildPath(rootFolder, trueFolder),
      notConfiguredMsg: 'Taskflow: Archive folder is not configured.',
      alreadyThereMsg: 'Taskflow: File is already in the archive.',
      movedMsg: 'Taskflow: Moved to archive.',
    });
  }

  async moveGoalToBacklog() {
    const { goalLabel, goalRootFolder, goalBacklogFolder } = this.settings;
    await this.manualMoveFile({
      label: goalLabel, fileType: 'goal',
      targetFolder: buildPath(goalRootFolder, goalBacklogFolder),
      notConfiguredMsg: 'Taskflow: Goal backlog folder is not configured.',
      alreadyThereMsg: 'Taskflow: File is already in the backlog.',
      movedMsg: 'Taskflow: Moved to backlog.',
    });
  }

  async archiveGoal() {
    const { goalLabel, goalRootFolder, goalTrueFolder } = this.settings;
    await this.manualMoveFile({
      label: goalLabel, fileType: 'goal',
      targetFolder: buildPath(goalRootFolder, goalTrueFolder),
      notConfiguredMsg: 'Taskflow: Goal archive folder is not configured.',
      alreadyThereMsg: 'Taskflow: File is already in the archive.',
      movedMsg: 'Taskflow: Moved to archive.',
    });
  }

  private async manualMoveFile(opts: {
    label: string;
    fileType: string;
    targetFolder: string;
    notConfiguredMsg: string;
    alreadyThereMsg: string;
    movedMsg: string;
  }): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    if (!activeFile.name.startsWith(`[${opts.label}-`)) {
      new Notice(`Taskflow: Active file is not a ${opts.fileType} file.`);
      return;
    }

    if (!opts.targetFolder && opts.notConfiguredMsg) {
      new Notice(opts.notConfiguredMsg);
      return;
    }

    const currentFolder = activeFile.parent?.path || '';
    if (currentFolder === opts.targetFolder) {
      new Notice(opts.alreadyThereMsg);
      return;
    }

    const newPath = opts.targetFolder
      ? `${opts.targetFolder}/${activeFile.name}`
      : activeFile.name;
    await this.ensureFolder(opts.targetFolder);
    await this.app.vault.rename(activeFile, newPath);
    new Notice(opts.movedMsg);
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

  private async applyCompletedDate(
    file: TFile,
    propertyValue: boolean,
    enable: boolean,
    datePropertyName: string
  ): Promise<void> {
    if (!enable || !datePropertyName) return;
    if (propertyValue === true) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (!frontmatter[datePropertyName]) {
          const now = new Date();
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          frontmatter[datePropertyName] = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
        }
      });
    } else if (propertyValue === false) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        delete frontmatter[datePropertyName];
      });
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
  private prevDoneValue = new Map<string, boolean>();
  private prevGoalDoneValue = new Map<string, boolean>();

  private initDoneTracking(): void {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatter) continue;
      const tv = cache.frontmatter[this.settings.propertyName];
      if (tv === true || tv === false) this.prevDoneValue.set(file.path, tv);
      const gv = cache.frontmatter[this.settings.goalPropertyName];
      if (gv === true || gv === false) this.prevGoalDoneValue.set(file.path, gv);
    }
  }

  async processTaskFile(file: TFile) {
    const originalPath = file.path;
    if (this.processing.has(originalPath)) {
      return;
    }

    this.processing.add(originalPath);
    let newPath = '';

    try {
      const { rootFolder, propertyName, trueFolder, falseFolder, enableBacklog, backlogFolder, enableCompletedDate, completedDatePropertyName } = this.settings;

      // If a root folder is configured, only process files inside it.
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) {
        return;
      }

      const absoluteTrueFolder = buildPath(rootFolder, trueFolder);
      const absoluteFalseFolder = buildPath(rootFolder, falseFolder);
      const absoluteBacklogFolder = enableBacklog ? buildPath(rootFolder, backlogFolder) : null;

      if (!propertyName || !absoluteTrueFolder || !absoluteFalseFolder) {
        console.warn('Taskflow Plugin: Settings are incomplete.');
        return;
      }

      const fileCache = this.app.metadataCache.getFileCache(file);
      if (!fileCache || !fileCache.frontmatter) {
        return; // No frontmatter, so nothing to do.
      }

      const currentFolderPath = file.parent?.path || '';
      const propertyValue = fileCache.frontmatter[propertyName];
      const prevValue = this.prevDoneValue.get(file.path);

      // Update tracked value before making decisions
      if (propertyValue === true || propertyValue === false) {
        this.prevDoneValue.set(file.path, propertyValue);
      } else {
        this.prevDoneValue.delete(file.path);
      }

      let targetFolder = '';

      if (propertyValue === true) {
        targetFolder = absoluteTrueFolder;
      } else if (propertyValue === false) {
        if (absoluteBacklogFolder && currentFolderPath === absoluteBacklogFolder) return; // in backlog, don't evict
        // Only evict from archive if done was previously true (i.e., the done property changed)
        if (currentFolderPath === absoluteTrueFolder && prevValue !== true) return;
        targetFolder = absoluteFalseFolder;
      } else {
        return; // Property not found or not a boolean.
      }

      if (currentFolderPath === targetFolder) {
        return; // Already in the correct folder.
      }

      newPath = `${targetFolder}/${file.name}`;
      this.processing.add(newPath);

      await this.ensureFolder(targetFolder);

      // 1. Move the file first.
      await this.app.vault.rename(file, newPath);
      console.log(`Taskflow Plugin: Moved "${originalPath}" to "${newPath}"`);

      // 2. Then, modify the frontmatter in the new location.
      await this.applyCompletedDate(file, propertyValue, enableCompletedDate, completedDatePropertyName);

    } catch (e) {
      console.error(`Taskflow Plugin: Error processing "${originalPath}":`, e);
    } finally {
      this.processing.delete(originalPath);
      if (newPath) this.processing.delete(newPath);
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

  async flagChildTasks(children: TFile[]): Promise<void> {
    for (const child of children) {
      await this.app.fileManager.processFrontMatter(child, (frontmatter) => {
        frontmatter['🚩'] = true;
      });
    }
  }

  askFlagChildren(childCount: number): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const safeResolve = (val: boolean) => { if (!resolved) { resolved = true; resolve(val); } };
      new FlagChildTasksModal(this.app, childCount, safeResolve).open();
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
    let newPath = '';

    try {
      const { goalRootFolder, goalPropertyName, goalTrueFolder, goalFalseFolder, goalBacklogFolder, enableGoalCompletedDate, goalCompletedDatePropertyName } = this.settings;

      // If a goal root folder is configured, only process files inside it.
      if (goalRootFolder && !file.path.startsWith(`${goalRootFolder}/`)) {
        return;
      }

      const absoluteTrueFolder = buildPath(goalRootFolder, goalTrueFolder);
      const absoluteFalseFolder = buildPath(goalRootFolder, goalFalseFolder);
      const absoluteGoalBacklogFolder = goalBacklogFolder ? buildPath(goalRootFolder, goalBacklogFolder) : null;

      if (!goalPropertyName || !absoluteTrueFolder || !absoluteFalseFolder) {
        console.warn('Taskflow Plugin: Goal settings are incomplete.');
        return;
      }

      const fileCache = this.app.metadataCache.getFileCache(file);
      if (!fileCache || !fileCache.frontmatter) {
        return; // No frontmatter, so nothing to do.
      }

      const currentFolderPath = file.parent?.path || '';
      const propertyValue = fileCache.frontmatter[goalPropertyName];
      const prevValue = this.prevGoalDoneValue.get(file.path);

      // Update tracked value before making decisions
      if (propertyValue === true || propertyValue === false) {
        this.prevGoalDoneValue.set(file.path, propertyValue);
      } else {
        this.prevGoalDoneValue.delete(file.path);
      }

      let targetFolder = '';

      if (propertyValue === true) {
        targetFolder = absoluteTrueFolder;
      } else if (propertyValue === false) {
        if (absoluteGoalBacklogFolder && currentFolderPath === absoluteGoalBacklogFolder) return; // in backlog, don't evict
        // Only evict from archive if done was previously true (i.e., the done property changed)
        if (currentFolderPath === absoluteTrueFolder && prevValue !== true) return;
        targetFolder = absoluteFalseFolder;
      }

      if (targetFolder && currentFolderPath !== targetFolder) {
        newPath = `${targetFolder}/${file.name}`;
        this.processing.add(newPath);

        await this.ensureFolder(targetFolder);

        // 1. Move the file first.
        await this.app.vault.rename(file, newPath);
        console.log(`Taskflow Plugin: Moved "${originalPath}" to "${newPath}"`);

        // 2. Then, modify the frontmatter in the new location.
        await this.applyCompletedDate(file, propertyValue, enableGoalCompletedDate, goalCompletedDatePropertyName);
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

      // Handle child task flag cascade when goal is flagged
      const flagValue = fileCache.frontmatter['🚩'];
      if (flagValue === true) {
        const behavior = this.settings.childTaskFlagBehavior;
        if (behavior !== 'never') {
          const children = this.findChildTasks(file);
          const unflaggedChildren = children.filter(child => {
            const cache = this.app.metadataCache.getFileCache(child);
            return cache?.frontmatter?.['🚩'] !== true;
          });
          if (unflaggedChildren.length > 0) {
            let shouldFlag = behavior === 'always';
            if (behavior === 'ask') {
              shouldFlag = await this.askFlagChildren(unflaggedChildren.length);
            }
            if (shouldFlag) {
              await this.flagChildTasks(unflaggedChildren);
            }
          }
        }
      }

    } catch (e) {
      console.error(`Taskflow Plugin: Error processing "${originalPath}":`, e);
    } finally {
      this.processing.delete(originalPath);
      if (newPath) this.processing.delete(newPath);
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

    const { enableBacklog, enableTaskRoutingDialog } = this.plugin.settings;
    let routeToBacklog = enableBacklog;
    let routeSelect: HTMLSelectElement | null = null;
    if (enableBacklog && enableTaskRoutingDialog) {
      const routeRow = contentEl.createDiv({ cls: 'taskflow-route-row' });
      routeRow.style.marginBottom = '1em';
      routeRow.createEl('label', { text: 'Route to: ' }).style.marginRight = '0.5em';
      routeSelect = routeRow.createEl('select');
      routeSelect.style.cssText = 'appearance: auto; -webkit-appearance: auto; padding: 2px 4px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-primary); color: var(--text-normal); cursor: pointer;';
      routeSelect.createEl('option', { text: 'Backlog', value: 'backlog' });
      routeSelect.createEl('option', { text: 'Active', value: 'active' });
    }

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        if (routeSelect) routeToBacklog = routeSelect.value === 'backlog';
        await this.createTask(input.value, routeToBacklog);
      }
    });

    const button = contentEl.createEl('button', { text: 'Create' });
    button.addEventListener('click', async () => {
      if (routeSelect) routeToBacklog = routeSelect.value === 'backlog';
      await this.createTask(input.value, routeToBacklog);
    });

    // Focus the input after the modal finishes animating open.
    setTimeout(() => input.focus(), 50);
  }

  async createTask(title: string, useBacklog: boolean) {
    title = title.trim();
    if (!title) return;

    const { rootFolder, taskLabel, taskCounter, propertyName, templatePath,
            backlogFolder } = this.plugin.settings;
    const paddedNum = String(taskCounter).padStart(3, '0');
    const fileName = `[${taskLabel}-${paddedNum}] ${title}.md`;
    const targetFolder = useBacklog
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

    // Suppress processTaskFile from reacting to the newly created file.
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

    const { enableGoalRoutingDialog } = this.plugin.settings;
    let routeToBacklog = true;
    let routeSelect: HTMLSelectElement | null = null;
    if (enableGoalRoutingDialog) {
      const routeRow = contentEl.createDiv({ cls: 'taskflow-route-row' });
      routeRow.style.marginBottom = '1em';
      routeRow.createEl('label', { text: 'Save to: ' }).style.marginRight = '0.5em';
      routeSelect = routeRow.createEl('select');
      routeSelect.style.cssText = 'appearance: auto; -webkit-appearance: auto; padding: 2px 4px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-primary); color: var(--text-normal); cursor: pointer;';
      routeSelect.createEl('option', { text: 'Backlog', value: 'backlog' });
      routeSelect.createEl('option', { text: 'Active', value: 'active' });
    }

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        if (routeSelect) routeToBacklog = routeSelect.value === 'backlog';
        await this.createGoal(input.value, routeToBacklog);
      }
    });

    const button = contentEl.createEl('button', { text: 'Create' });
    button.addEventListener('click', async () => {
      if (routeSelect) routeToBacklog = routeSelect.value === 'backlog';
      await this.createGoal(input.value, routeToBacklog);
    });

    // Focus the input after the modal finishes animating open.
    setTimeout(() => input.focus(), 50);
  }

  async createGoal(title: string, useBacklog: boolean) {
    title = title.trim();
    if (!title) return;

    const { goalRootFolder, goalLabel, goalCounter, goalPropertyName, goalTemplatePath,
            goalBacklogFolder } = this.plugin.settings;
    const paddedNum = String(goalCounter).padStart(3, '0');
    const fileName = `[${goalLabel}-${paddedNum}] ${title}.md`;
    const targetFolder = useBacklog
      ? buildPath(goalRootFolder, goalBacklogFolder)
      : (goalRootFolder || '');
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

class FlagChildTasksModal extends Modal {
  private resolvePromise: (value: boolean) => void;
  private childCount: number;

  constructor(app: App, childCount: number, resolvePromise: (value: boolean) => void) {
    super(app);
    this.childCount = childCount;
    this.resolvePromise = resolvePromise;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Flag child tasks?' });
    contentEl.createEl('p', {
      text: `This goal has ${this.childCount} unflagged child task(s). Flag them too?`
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const yesBtn = buttonContainer.createEl('button', { text: 'Yes, flag them', cls: 'mod-cta' });
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

      new Setting(containerEl)
        .setName('Show routing dialog')
        .setDesc('When creating a task, ask whether to send it to the backlog or active folder.')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.enableTaskRoutingDialog)
          .onChange(async (value) => {
            this.plugin.settings.enableTaskRoutingDialog = value;
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
          .setPlaceholder('done')
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

    new Setting(containerEl)
      .setName('Show routing dialog')
      .setDesc('When creating a goal, ask whether to send it to the backlog or active folder.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableGoalRoutingDialog)
        .onChange(async (value) => {
          this.plugin.settings.enableGoalRoutingDialog = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Child Task Behavior' });

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

    new Setting(containerEl)
      .setName('When a goal is flagged')
      .setDesc('Controls whether child tasks are automatically flagged when the goal is flagged.')
      .addDropdown(dropdown => dropdown
        .addOption('ask', 'Ask me each time')
        .addOption('always', 'Always flag child tasks')
        .addOption('never', 'Never flag child tasks')
        .setValue(this.plugin.settings.childTaskFlagBehavior)
        .onChange(async (value: string) => {
          this.plugin.settings.childTaskFlagBehavior = value as 'ask' | 'always' | 'never';
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
          .setPlaceholder('done')
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
