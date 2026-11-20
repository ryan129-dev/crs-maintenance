# 私库升级与部署

origin 指向 ryan129-dev/claude-relay-service，upstream 指向 Wei-Shaw/claude-relay-service。私库 main 维护经审阅的定制源码。新克隆可用以下命令添加作者仓库。

```sh
git remote add upstream https://github.com/Wei-Shaw/claude-relay-service.git
```

## 同步一个版本

在干净工作区执行，将 tag 设置为要引入的作者版本。

```sh
tag=v1.1.316
git switch main
git pull --ff-only origin main
git fetch upstream tag "$tag"
git switch -c "upgrade/$tag"
git merge --no-ff "$tag"
```

v1.1.315 的历史衔接仅需做一次。后续正常合并标签。如有冲突，同时检查作者的行为变化和私库的定制。安装锁文件对应的依赖，准备本地测试配置，运行 npm test -- --runInBand。确认模型目录和 Gemini 错误处理后，推送升级分支并开 PR。

PR 使用 Create a merge commit，保留上游父提交。合并后用 git merge-base --is-ancestor "$tag" origin/main 校验祖先关系。仓库沿用了作者的 main 推送发布工作流，如沿用当前人工部署方式，合并提交消息加入 [skip ci]，避免额外发布。

## 生产发布

以审阅通过的私库 main 提交为构建输入。核对目前运行镜像的专有补丁与构建配置已纳入新镜像，记录旧镜像和 Compose 备份。镜像标签带上游版本和私库提交短 SHA。更新生产 Compose 的 claude-relay 镜像后，在生产项目目录执行：

```sh
docker compose -p crs up -d --no-deps --wait claude-relay
```

核对运行镜像、容器健康和公网 /health，用测试 Key 验证 /api/v1/models 的定制模型和 Grok 专用列表。验收失败时恢复备份的 Compose，再执行同一条命令切回原镜像。
