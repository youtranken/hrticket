import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

// Register only what the dashboard uses — keeps the bundle lean (story 10.3).
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  CanvasRenderer,
]);

/**
 * Thin ECharts wrapper (Story 10.3): mounts a chart into a div, updates on option
 * change, resizes with its CONTAINER (ResizeObserver — so the chart reflows when the
 * sidebar collapses or a panel toggles, not only on window resize), and forwards
 * bar/line clicks for drill-through.
 */
export function EChart({
  option,
  height = 320,
  onClick,
}: {
  option: EChartsCoreOption;
  height?: number;
  onClick?: (params: { name: string; dataIndex: number; seriesName?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    // Container-level resize (sider collapse, panel toggle, flex reflow) — window
    // 'resize' alone misses these. Guarded for older engines without ResizeObserver.
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => chart.resize()) : null;
    ro?.observe(ref.current);
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.off('click');
    if (onClick) {
      chart.on('click', (p: unknown) => {
        const e = p as { name: string; dataIndex: number; seriesName?: string };
        onClick({ name: e.name, dataIndex: e.dataIndex, seriesName: e.seriesName });
      });
    }
  }, [onClick]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}
