// Copyright (C) 2023 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use size file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {Anchor} from '../../widgets/anchor';
import {Button} from '../../widgets/button';
import {DetailsShell} from '../../widgets/details_shell';
import {GridLayout} from '../../widgets/grid_layout';
import {Section} from '../../widgets/section';
import {SqlRef} from '../../widgets/sql_ref';
import {Tree, TreeNode} from '../../widgets/tree';
import {Intent} from '../../widgets/common';
import {SchedSqlId} from '../../components/sql_utils/core_types';
import {
  getThreadState,
  getThreadStateFromConstraints,
  ThreadState,
} from '../../components/sql_utils/thread_state';
import {DurationWidget} from '../../components/widgets/duration';
import {Timestamp} from '../../components/widgets/timestamp';
import {getProcessName} from '../../components/sql_utils/process';
import {
  getFullThreadName,
  getThreadName,
} from '../../components/sql_utils/thread';
import {ThreadStateRef} from '../../components/widgets/thread_state';
import {
  CRITICAL_PATH_LITE_CMD,
} from '../../public/exposed_commands';
import {goToSchedSlice} from '../../components/widgets/sched';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {Trace} from '../../public/trace';
import {formatDuration} from '../../components/time_utils';

interface RelatedThreadStates {
  prev?: ThreadState;
  next?: ThreadState;
  waker?: ThreadState;
  wakerInterruptCtx?: boolean;
  wakee?: ThreadState[];
}

export class ThreadStateDetailsPanel implements TrackEventDetailsPanel {
  private threadState?: ThreadState;
  private relatedStates?: RelatedThreadStates;

  constructor(
    private readonly trace: Trace,
    private readonly id: number,
  ) {}

  async load() {
    const id = this.id;
    this.threadState = await getThreadState(this.trace.engine, id);

    if (!this.threadState) {
      return;
    }

    const relatedStates: RelatedThreadStates = {};
    relatedStates.prev = (
      await getThreadStateFromConstraints(this.trace.engine, {
        filters: [
          `ts + dur = ${this.threadState.ts}`,
          `utid = ${this.threadState.thread?.utid}`,
        ],
        limit: 1,
      })
    )[0];
    relatedStates.next = (
      await getThreadStateFromConstraints(this.trace.engine, {
        filters: [
          `ts = ${this.threadState.ts + this.threadState.dur}`,
          `utid = ${this.threadState.thread?.utid}`,
        ],
        limit: 1,
      })
    )[0];

    // note: this might be valid even if there is no |waker| slice, in the case
    // of an interrupt wakeup while in the idle process (which is omitted from
    // the thread_state table).
    relatedStates.wakerInterruptCtx = this.threadState.wakerInterruptCtx;

    if (this.threadState.wakerId !== undefined) {
      relatedStates.waker = await getThreadState(
        this.trace.engine,
        this.threadState.wakerId,
      );
    } else if (
      this.threadState.state == 'Running' &&
      relatedStates.prev.wakerId != undefined
    ) {
      // For running slices, extract waker info from the preceding runnable.
      relatedStates.waker = await getThreadState(
        this.trace.engine,
        relatedStates.prev.wakerId,
      );
      relatedStates.wakerInterruptCtx = relatedStates.prev.wakerInterruptCtx;
    }

    relatedStates.wakee = await getThreadStateFromConstraints(
      this.trace.engine,
      {
        filters: [
          `waker_id = ${id}`,
          `(irq_context is null or irq_context = 0)`,
        ],
      },
    );
    this.relatedStates = relatedStates;
  }

  render() {
    // TODO(altimin/stevegolton): Differentiate between "Current Selection" and
    // "Pinned" views in DetailsShell.
    return m(
      DetailsShell,
      {title: 'Thread State', description: this.renderLoadingText()},
      m(
        GridLayout,
        m(
          Section,
          {title: 'Details'},
          this.threadState && this.renderTree(this.threadState),
        ),
        m(
          Section,
          {title: 'Related thread states'},
          this.renderRelatedThreadStates(),
        ),
        m(
          Section,
          {title: 'Frame Dependencies'},
          this.renderFrameDependencies(),
        ),
      ),
    );
  }
  private renderFrameDependencies() {
    const canvasWidth = 800;
    const canvasHeight = 400;

    return [
      m('canvas', {
        width: canvasWidth,
        height: canvasHeight,
        style: {
          border: '1px solid #ccc',
          margin: '10px 0',
        },
        oncreate: (vnode) => {
          const canvas = vnode.dom as HTMLCanvasElement;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          // Helper function to draw arrow
          const drawArrow = (fromX: number, fromY: number, toX: number, toY: number) => {
            const headLength = 15; // 箭头长度
            const headAngle = Math.PI / 6; // 箭头角度 (30度)

            // 计算箭头方向
            const angle = Math.atan2(toY - fromY, toX - fromX);

            // 调整箭头终点，使其不会与节点重叠
            const nodeRadius = 20;
            const dx = toX - fromX;
            const dy = toY - fromY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const adjustedToX = fromX + (dx * (distance - nodeRadius)) / distance;
            const adjustedToY = fromY + (dy * (distance - nodeRadius)) / distance;

            // 计算箭头两个端点
            const point1X = adjustedToX - headLength * Math.cos(angle - headAngle);
            const point1Y = adjustedToY - headLength * Math.sin(angle - headAngle);
            const point2X = adjustedToX - headLength * Math.cos(angle + headAngle);
            const point2Y = adjustedToY - headLength * Math.sin(angle + headAngle);

            // 绘制箭头主体
            ctx.beginPath();
            ctx.moveTo(fromX, fromY);
            ctx.lineTo(adjustedToX, adjustedToY);
            ctx.stroke();

            // 绘制箭头头部
            ctx.beginPath();
            ctx.moveTo(adjustedToX, adjustedToY);
            ctx.lineTo(point1X, point1Y);
            ctx.lineTo(point2X, point2Y);
            ctx.closePath();
            ctx.fill();
          };

          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
          
          //TODO 实现动态数据加载
          // Sample data - you can replace this with real data
          const nodes = [
            { id: 'S', x: 50, y: 200, color: '#ff0000', label: 'Start' },
            { id: '1', x: 200, y: 100, color: '#4287f5', label: 'Thread 1' },
            { id: '2', x: 200, y: 300, color: '#42f54b', label: 'Thread 2' },
            { id: '3', x: 400, y: 200, color: '#f542f2', label: 'Thread 3' },
            { id: 'E', x: 600, y: 200, color: '#ff0000', label: 'End' }
          ];

          const edges = [
            { from: 'S', to: '1', type: 'SCHED_WAKEUP', color: '#0000ff', style: [5, 5] },
            { from: 'S', to: '2', type: 'BINDER', color: '#00ff00', style: [] },
            { from: '1', to: '3', type: 'IPC', color: '#ff00ff', style: [10, 5] },
            { from: '2', to: '3', type: 'SYNC', color: '#ffa500', style: [] },
            { from: '3', to: 'E', type: 'COMPLETE', color: '#ff0000', style: [] }
          ];

          // Draw edges with arrows
          edges.forEach(edge => {
            const fromNode = nodes.find(n => n.id === edge.from);
            const toNode = nodes.find(n => n.id === edge.to);
            if (!fromNode || !toNode) return;

            ctx.strokeStyle = edge.color;
            ctx.fillStyle = edge.color;
            if (edge.style.length > 0) {
              ctx.setLineDash(edge.style);
            } else {
              ctx.setLineDash([]);
            }
            ctx.lineWidth = 2;

            // Draw the line with arrow
            drawArrow(fromNode.x, fromNode.y, toNode.x, toNode.y);
          });

          // Draw nodes (on top of edges)
          nodes.forEach(node => {
            // Draw circle
            ctx.beginPath();
            ctx.arc(node.x, node.y, 20, 0, 2 * Math.PI);
            ctx.fillStyle = node.color;
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Draw label
            ctx.fillStyle = '#000';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(node.label, node.x, node.y);
          });

          // Draw legend
          const legendX = 650;
          const legendY = 50;
          const types = [
            { label: 'SCHED_WAKEUP', color: '#0000ff', style: [5, 5] },
            { label: 'BINDER', color: '#00ff00', style: [] },
            { label: 'IPC', color: '#ff00ff', style: [10, 5] },
            { label: 'SYNC', color: '#ffa500', style: [] }
          ];

          types.forEach((type, i) => {
            const y = legendY + i * 25;
            
            // Draw line with arrow for legend
            ctx.strokeStyle = type.color;
            ctx.fillStyle = type.color;
            ctx.setLineDash(type.style);
            ctx.lineWidth = 2;
            drawArrow(legendX, y, legendX + 40, y);

            // Draw label
            ctx.fillStyle = '#000';
            ctx.font = '12px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(type.label, legendX + 50, y);
          });
        }
      }),
      m(TreeNode, {
        left: 'Duration',
        right: '1ms',
      })
    ];
  }
  private renderLoadingText() {
    if (!this.threadState) {
      return 'Loading';
    }
    return this.id;
  }

  private renderTree(threadState: ThreadState) {
    const thread = threadState.thread;
    const process = threadState.thread?.process;
    return m(
      Tree,
      m(TreeNode, {
        left: 'Start time',
        right: m(Timestamp, {ts: threadState.ts}),
      }),
      m(TreeNode, {
        left: 'Duration',
        right: m(DurationWidget, {dur: threadState.dur}),
      }),
      m(TreeNode, {
        left: 'State',
        right: this.renderState(
          threadState.state,
          threadState.cpu,
          threadState.schedSqlId,
        ),
      }),
      threadState.blockedFunction &&
        m(TreeNode, {
          left: 'Blocked function',
          right: threadState.blockedFunction,
        }),
      process &&
        m(TreeNode, {
          left: 'Process',
          right: getProcessName(process),
        }),
      thread && m(TreeNode, {left: 'Thread', right: getThreadName(thread)}),
      threadState.priority !== undefined &&
        m(TreeNode, {
          left: 'Priority',
          right: threadState.priority,
        }),
      m(TreeNode, {
        left: 'SQL ID',
        right: m(SqlRef, {table: 'thread_state', id: threadState.id}),
      }),
    );
  }

  private renderState(
    state: string,
    cpu: number | undefined,
    id: SchedSqlId | undefined,
  ): m.Children {
    if (!state) {
      return null;
    }
    if (id === undefined || cpu === undefined) {
      return state;
    }
    return m(
      Anchor,
      {
        title: 'Go to CPU slice',
        icon: 'call_made',
        onclick: () => goToSchedSlice(id),
      },
      `${state} on CPU ${cpu}`,
    );
  }

  private renderRelatedThreadStates(): m.Children {
    if (this.threadState === undefined || this.relatedStates === undefined) {
      return 'Loading';
    }
    const startTs = this.threadState.ts;
    const renderRef = (state: ThreadState, name?: string) =>
      m(ThreadStateRef, {
        id: state.id,
        name,
      });

    const nameForNextOrPrev = (threadState: ThreadState) =>
      `${threadState.state} for ${formatDuration(this.trace, threadState.dur)}`;

    const renderWaker = (related: RelatedThreadStates) => {
      // Could be absent if:
      // * this thread state wasn't woken up (e.g. it is a running slice).
      // * the wakeup is from an interrupt during the idle process (which
      //   isn't populated in thread_state).
      // * at the start of the trace, before all per-cpu scheduling is known.
      const hasWakerId = related.waker !== undefined;
      // Interrupt context for the wakeups is absent from older traces.
      const hasInterruptCtx = related.wakerInterruptCtx !== undefined;

      if (!hasWakerId && !hasInterruptCtx) {
        return null;
      }
      if (related.wakerInterruptCtx) {
        return m(TreeNode, {
          left: 'Woken by',
          right: `Interrupt`,
        });
      }
      return (
        related.waker &&
        m(TreeNode, {
          left: hasInterruptCtx ? 'Woken by' : 'Woken by (maybe interrupt)',
          right: renderRef(
            related.waker,
            getFullThreadName(related.waker.thread),
          ),
        })
      );
    };

    const renderWakees = (related: RelatedThreadStates) => {
      if (related.wakee === undefined || related.wakee.length == 0) {
        return null;
      }
      const hasInterruptCtx = related.wakee[0].wakerInterruptCtx !== undefined;
      return m(
        TreeNode,
        {
          left: hasInterruptCtx
            ? 'Woken threads'
            : 'Woken threads (maybe interrupt)',
        },
        related.wakee.map((state) =>
          m(TreeNode, {
            left: m(Timestamp, {
              ts: state.ts,
              display: `+${formatDuration(this.trace, state.ts - startTs)}`,
            }),
            right: renderRef(state, getFullThreadName(state.thread)),
          }),
        ),
      );
    };

    return [
      m(
        Tree,
        this.relatedStates.prev &&
          m(TreeNode, {
            left: 'Previous state',
            right: renderRef(
              this.relatedStates.prev,
              nameForNextOrPrev(this.relatedStates.prev),
            ),
          }),
        this.relatedStates.next &&
          m(TreeNode, {
            left: 'Next state',
            right: renderRef(
              this.relatedStates.next,
              nameForNextOrPrev(this.relatedStates.next),
            ),
          }),
        renderWaker(this.relatedStates),
        renderWakees(this.relatedStates),
      ),
      this.trace.commands.hasCommand(CRITICAL_PATH_LITE_CMD) &&
        m(Button, {
          label: 'Critical path lite',
          intent: Intent.Primary,
          onclick: () => {
            this.trace.commands.runCommand(
              CRITICAL_PATH_LITE_CMD,
              this.threadState?.thread?.utid,
            );
          },
        }),
    ];
  }

  isLoading() {
    return this.threadState === undefined || this.relatedStates === undefined;
  }
}
