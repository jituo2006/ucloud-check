// The input comes from the rendered, all-weeks JWGL timetable, not cookies or page internals.
export function expandTimetable(input) {
  if (!/^\d{4}-\d{4}-[12]$/.test(input.term || '')) throw new Error('学期无效');
  const monday = Date.parse(input.firstMonday + 'T00:00:00+08:00');
  if (!Number.isFinite(monday) || new Date(monday + 8 * 3600000).getUTCDay() !== 1) throw new Error('第一周周一日期无效');
  const periods = new Map(input.periods.map(text => {
    const match = text.match(/^(\d+)\s+(\d\d:\d\d)-(\d\d:\d\d)$/);
    if (!match) throw new Error('节次时刻无效');
    return [Number(match[1]), { start: match[2], end: match[3] }];
  }));
  const windows = new Map();
  for (const item of input.rules) {
    if (!Number.isInteger(item.weekday) || item.weekday < 1 || item.weekday > 7) throw new Error('星期无效');
    const rule = item.rule.match(/^([\d,-]+)\(周\)\[([\d-]+)节\]$/);
    if (!rule) throw new Error('暂不支持的周次规则：' + item.rule);
    const weeks = new Set();
    for (const part of rule[1].split(',')) {
      const bounds = part.split('-').map(Number), a = bounds[0], b = bounds[1] ?? a;
      if (bounds.length > 2 || a < 1 || b > 30 || a > b) throw new Error('周次范围无效');
      for (let week = a; week <= b; week++) weeks.add(week);
    }
    const sections = [...new Set(rule[2].split('-').map(Number))].sort((a, b) => a - b);
    if (!sections.length || sections.some(n => !periods.has(n))) throw new Error('缺少节次时间');
    // Preserve separated blocks rather than treating an unscheduled gap as class time.
    const blocks = [];
    for (const section of sections) {
      const previous = blocks.at(-1);
      if (previous && section === previous.at(-1) + 1) previous.push(section); else blocks.push([section]);
    }
    for (const week of weeks) for (const block of blocks) {
      const date = new Date(monday + ((week - 1) * 7 + item.weekday - 1) * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
      const start = `${date}T${periods.get(block[0]).start}:00+08:00`;
      const end = `${date}T${periods.get(block.at(-1)).end}:00+08:00`;
      if (Date.parse(end) <= Date.parse(start)) throw new Error('课程起止时间无效');
      windows.set([item.title, start, end].join('|'), { title: item.title, week, start, end });
    }
  }
  return { term: input.term, firstMonday: input.firstMonday, source: 'jwgl-rendered-all-weeks',
    windows: [...windows.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) };
}
