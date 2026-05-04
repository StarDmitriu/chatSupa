import { Manrope } from 'next/font/google'
import { TimingHubRoot } from '@/components/TimingHubRoot'
import { NotifyProvider } from '@/ui/notify/notify'
import { LoaderProvider } from '@/ui/loader/LoaderProvider'
import { ChunkLoadRecoveryClient } from '@/ui/ChunkLoadRecoveryClient'
import './globals.css'
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
})

export const metadata = {
  icons: { icon: '/iconFoto.png' },
}

const criticalStyles = `
html,body{margin:0;padding:0;background:#fff;color:#2f2f2f;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
a{color:inherit;text-decoration:none;}
`

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode
}>) {
	return (
		<html lang='ru' className={manrope.className}>
			<head>
				<style dangerouslySetInnerHTML={{ __html: criticalStyles }} />
			</head>
			<body>
				<ChunkLoadRecoveryClient />
				<NotifyProvider>
					<LoaderProvider>
						<TimingHubRoot>{children}</TimingHubRoot>
					</LoaderProvider>
				</NotifyProvider>
			</body>
		</html>
	)
}
