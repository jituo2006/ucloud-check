// Read-only protocol sampling: exclude rosters, names, credentials and arbitrary string values.
export function summarizeAttendance(data) {
  const shape = [], signals = {};
  const allowed = /(?:status|state|time|signed|issign|isattend|isclocked)$/i;
  const visit = (value, path = '', depth = 0) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return;
    for (const [key, field] of Object.entries(value).slice(0, 100)) {
      const name = path ? path + '.' + key : key;
      const type = Array.isArray(field) ? 'array' : field === null ? 'null' : typeof field;
      shape.push({ path: name, type });
      if (allowed.test(key) && ['number', 'boolean'].includes(typeof field)) signals[name] = field;
      if (allowed.test(key) && typeof field === 'string' && (/^-?\d+$/.test(field) || /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(field))) signals[name] = field.slice(0, 60);
      if (type === 'object') visit(field, name, depth + 1);
    }
  };
  visit(data);
  const source = data?.attendanceBasicInfo;
  const basic = source && typeof source === 'object' ? Object.fromEntries(
    ['id', 'siteId', 'classLessonId', 'attendanceBasicStatus', 'attendanceStartTime', 'attendanceEndTime', 'attendanceLimitTime']
      .filter(key => Object.hasOwn(source, key) && ['number', 'string', 'boolean'].includes(typeof source[key]))
      .map(key => [key, typeof source[key] === 'string' ? source[key].slice(0, 80) : source[key]])) : null;
  return { basic, signals, shape: shape.slice(0, 200) };
}
