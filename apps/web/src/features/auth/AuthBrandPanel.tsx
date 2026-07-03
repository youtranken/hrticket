import { useTranslation } from 'react-i18next';
import { Typography } from 'antd';
import { CheckCircleFilled } from '@ant-design/icons';

const { Title, Text } = Typography;

/**
 * The navy brand panel shared by the full-screen auth pages (login + forced
 * password change). Layered styling lives in index.css (.login-brand*); this is
 * just the content. Hidden < 992px, where a compact top bar stands in.
 */
export function AuthBrandPanel() {
  const { t } = useTranslation();
  return (
    <div className="login-brand">
      <img
        src="/logo.png"
        alt="Phú Mỹ Hưng"
        style={{ height: 52, background: '#fff', borderRadius: 12, padding: 8, alignSelf: 'flex-start' }}
      />
      <div>
        <Title className="login-brand__title">{t('login.brandTitle')}</Title>
        <Text className="login-brand__tagline">{t('login.brandTagline')}</Text>
        <ul className="login-brand__points">
          <li>
            <CheckCircleFilled />
            {t('login.point1')}
          </li>
          <li>
            <CheckCircleFilled />
            {t('login.point2')}
          </li>
          <li>
            <CheckCircleFilled />
            {t('login.point3')}
          </li>
        </ul>
      </div>
      <Text className="login-brand__foot">{t('login.brandFooter')}</Text>
    </div>
  );
}
