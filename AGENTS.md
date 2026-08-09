# ExampleProject 工作区入口

Git 工作目录位于当前 `ExampleProject/` 目录，使用以下布局：

* `main/`：主分支中的应用源码和集成入口
* `worktrees/`：独立任务 worktree；实际检出内容不纳入主工作目录版本控制
* `releases/`：发布快照和产物；不纳入 Git

处理 `main/` 或 `worktrees/` 下的任何仓库任务前，必须从仓库根目录完整读取：

1. [`main/AGENTS.md`](./main/AGENTS.md)
2. [`main/WORKTREES.md`](./main/WORKTREES.md)

Git 命令默认从当前 `ExampleProject/` 根目录执行。不要运行仍引用旧 `Wiki知识库` 路径的 worktree 脚本，也不要在 `releases/` 中开发。

只进行本地的git管理，不处理任何远端仓库。
下载任何环境需要的文件，需要先向用户申请，不允许私自下载。使用环境若不是必须，不要在代码库中安装环境，安装到本地环境不放在代码库。

完成任何功能后，必须先自行验证功能是否正确，并截取能够证明结果的界面或终端画面。验收完成后，向用户汇报改动、检查结果、截图、分支和提交信息，并分别询问是否合并到 `main`、是否部署；没有用户对相应动作的明确批准，不得合并或部署。

