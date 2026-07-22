import { useTranslation } from 'react-i18next';
import { CheckCircleFilled, CloseCircleOutlined } from '@ant-design/icons';
import { palette } from '../../theme';

/**
 * Realtime password criteria checklist (#36). Only the ≥8 rule is ENFORCED (mirror
 * of the BE zod schema); letter/digit are live recommendations, not blockers.
 */
export function PasswordCriteria({ value }: { value: string }) {
  const { t } = useTranslation();
  const rows: Array<[boolean, string]> = [
    [value.length >= 8, t('auth.pwCriteria.len')],
    [/[a-zA-Z]/.test(value), t('auth.pwCriteria.letter')],
    [/\d/.test(value), t('auth.pwCriteria.digit')],
  ];
  return (
    <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
      {rows.map(([ok, label]) => (
        <span key={label} style={{ fontSize: 12, color: ok ? '#389E0D' : palette.textTertiary }}>
          {ok ? <CheckCircleFilled /> : <CloseCircleOutlined />} {label}
        </span>
      ))}
    </div>
  );
}
