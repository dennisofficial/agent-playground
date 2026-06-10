import { redirect } from 'next/navigation';

/** The admin surface is the whole app for now. */
export default function Home() {
  redirect('/admin');
}
