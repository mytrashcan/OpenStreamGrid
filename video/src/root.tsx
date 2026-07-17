import { Composition } from "remotion";
import { OpenStreamGridVideo } from "./video";

export const VideoRoot = (): React.JSX.Element => (
  <Composition
    id="OpenStreamGridDevpost"
    component={OpenStreamGridVideo}
    durationInFrames={2340}
    fps={30}
    width={1920}
    height={1080}
  />
);
